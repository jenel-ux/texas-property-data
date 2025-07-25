import 'dotenv/config';
import runDallasAssessmentScraper from './scrapers/dallas/assessment-scraper.js';
import runClerkScraper from './scrapers/dallas/clerk-scraper.js';
import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_ANON_KEY;

if (!supabaseUrl || !supabaseKey) {
  throw new Error("Supabase URL and Key are required in the .env file");
}
const supabase = createClient(supabaseUrl, supabaseKey);

// --- Helper Functions ---
function cleanAndParseNumber(value: string | undefined | null): number | null {
  if (!value) return null;
  const cleaned = value.replace(/[^0-9.-]+/g, "");
  const number = parseFloat(cleaned);
  return isNaN(number) ? null : number;
}
function formatAsDate(dateString: string | undefined | null): string | null {
    if (!dateString) return null;
    try {
        return new Date(dateString).toISOString().split('T')[0];
    } catch (e) {
        return null;
    }
}
function parseLegalDescription(description: string | undefined | null) {
    if (!description) return {};
    const lines = description.split('\n').map(line => line.trim()).filter(line => line);
    const result: { [key: string]: string | null } = { subdivision: null, block: null, city_block: null, lot1: null, lot2: null };
    
    const fullDescription = lines.join(' ');

    const blockIndex = fullDescription.toUpperCase().indexOf('BLK');
    if (blockIndex > 0) {
        result.subdivision = fullDescription.substring(0, blockIndex).trim();
    } else if (lines.length > 0 && !lines[0].toUpperCase().includes('BLK') && !lines[0].toUpperCase().includes('BLOCK')) {
         result.subdivision = lines[0];
    }

    const blockMatch = fullDescription.match(/(?:BLK|BLOCK)\s*([^\s/]+)(?:\s*\/\s*(\S+))?/i);
    if (blockMatch) {
        result.block = blockMatch[1] || null;
        result.city_block = blockMatch[2] || null;
    }

    const lotMatch = fullDescription.match(/(?:LTS|LT|LOTS|LOT)\s*(\d+)(?:\s*&\s*(\d+))?/i);
    if (lotMatch) {
        result.lot1 = lotMatch[1] || null;
        result.lot2 = lotMatch[2] || null;
    }

    return result;
}

const propertiesToScrape = [
  { addressNumber: '9920', streetName: 'Gulf Palm' },
];

async function runAllScrapers() {
  for (const property of propertiesToScrape) {
    try {
      console.log(`--- Starting Assessment scraper for ${property.addressNumber} ${property.streetName} ---`);
      const assessmentResult = await runDallasAssessmentScraper(property.addressNumber, property.streetName);

      if (assessmentResult.success && assessmentResult.data) {
        console.log('Assessment scraping successful. Storing data...');
        const parsedLegal = parseLegalDescription(assessmentResult.data.legalDescription);
        
        const { error: assessmentError } = await saveDataToSupabase(assessmentResult.data, parsedLegal);
        if (assessmentError) {
          console.error(`Error saving assessment data:`, assessmentError.message);
          continue; 
        }
        console.log(`Successfully saved assessment data.`);

        if (parsedLegal.subdivision && parsedLegal.block && parsedLegal.lot1) {
            console.log(`--- Starting Clerk scraper for ${property.addressNumber} ${property.streetName} ---`);
            const clerkResult = await runClerkScraper({
                lot: parsedLegal.lot1,
                block: parsedLegal.block,
                city_block: parsedLegal.city_block,
                subdivision: parsedLegal.subdivision,
            });

            if (clerkResult.success && clerkResult.data) {
                if (clerkResult.data.searchUrl) {
                    await supabase
                      .from('properties')
                      .update({ clerk_search_url: clerkResult.data.searchUrl })
                      .eq('account_number', assessmentResult.data.accountNumber);
                }

                if (clerkResult.data.documents && clerkResult.data.documents.length > 0) {
                    // --- NEW: Filter the documents before saving ---
                    const filteredDocuments = clerkResult.data.documents.filter(doc => {
                        const docLegal = doc.legal_description?.toUpperCase() || '';
                        // Check if the document's legal description contains all our key parts
                        return docLegal.includes(parsedLegal.subdivision!.toUpperCase()) &&
                               docLegal.includes(`LOT: ${parsedLegal.lot1}`) &&
                               docLegal.includes(`BLOCK: ${parsedLegal.block}`);
                    });

                    console.log(`Found ${clerkResult.data.documents.length} total documents, filtered down to ${filteredDocuments.length} relevant documents.`);

                    if (filteredDocuments.length > 0) {
                        console.log("Storing filtered documents...");
                        const { error: clerkError } = await saveClerkDataToSupabase(assessmentResult.data.accountNumber, filteredDocuments);
                        if (clerkError) {
                            console.error("Error saving clerk data:", clerkError.message);
                        } else {
                            console.log("Successfully saved clerk documents.");
                        }
                    } else {
                        console.log("No relevant documents found after filtering.");
                    }
                } else {
                    console.log("Clerk scraper found no documents to save.");
                }
            } else {
                console.log("Clerk scraper failed:", clerkResult.error);
            }
        } else {
            console.log("Skipping clerk scraper: Missing required legal description data.");
        }

      } else {
        console.log(`Assessment scraping failed:`, assessmentResult.error);
      }
    } catch (error) {
      console.error(`A critical error occurred while scraping:`, error);
    }
    await new Promise(resolve => setTimeout(resolve, 2000));
  }
}

async function saveDataToSupabase(scrapedData: any, parsedLegal: any) {
    const { accountNumber, address, propertyValue, propertyDetails, currentOwners, ownershipHistory, marketValueHistory, exemptions, int_number, deed_xfer_date, cad_url } = scrapedData;

    const { error: propertyError } = await supabase.from('properties').upsert({
        account_number: accountNumber,
        address: address,
        improvement_value: cleanAndParseNumber(propertyValue?.improvementValue),
        land_value: cleanAndParseNumber(propertyValue?.landValue),
        total_market_value: cleanAndParseNumber(propertyValue?.totalMarketValue),
        year_built: cleanAndParseNumber(propertyDetails?.yearBuilt),
        living_area: cleanAndParseNumber(propertyDetails?.livingArea),
        cad_url: cad_url,
        subdivision: parsedLegal.subdivision,
        block: parsedLegal.block,
        city_block: parsedLegal.city_block,
        lot1: parsedLegal.lot1,
        lot2: parsedLegal.lot2,
    }, { onConflict: 'account_number' });
    if (propertyError) return { error: propertyError };

    const allOwners = new Map<string, { address?: string }>();
    if (currentOwners) { currentOwners.forEach((owner: any) => { if (owner.name) allOwners.set(owner.name.trim(), { address: owner.address?.trim() }); }); }
    if (ownershipHistory) { ownershipHistory.forEach((rec: any) => { const parts = rec.ownerNameAndAddress?.split('\n') || []; const name = parts[0]?.trim(); if (name && !allOwners.has(name)) { const address = parts.slice(1).join(' ').trim(); allOwners.set(name, { address }); } }); }
    if (allOwners.size === 0) { console.log("No owners found."); return { error: null }; }
    
    const ownerRecords = Array.from(allOwners.entries()).map(([name, data]) => ({ owner_name: name, owner_address: data.address }));
    const { data: upsertedOwners, error: ownerError } = await supabase.from('owners').upsert(ownerRecords, { onConflict: 'owner_name' }).select('id, owner_name');
    if (ownerError) return { error: ownerError };
    
    const ownerNameToIdMap = new Map(upsertedOwners!.map(o => [o.owner_name, o.id]));
    
    await supabase.from('ownership_history').delete().eq('property_account_number', accountNumber);
    await supabase.from('value_history').delete().eq('property_account_number', accountNumber);
    await supabase.from('exemptions').delete().eq('property_account_number', accountNumber);

    if (ownershipHistory?.length > 0) {
        const sortedHistory = ownershipHistory
            .map((rec: any) => {
                const name = (rec.ownerNameAndAddress?.split('\n')[0] || '').trim();
                const intNum = rec.int_number?.trim();
                return {
                    year: cleanAndParseNumber(rec.year),
                    ownerName: name,
                    int_number: intNum && intNum.startsWith('INT') ? intNum : null,
                    deed_xfer_date: formatAsDate(rec.deed_xfer_date)
                };
            })
            .filter((rec: any) => rec.year !== null && rec.ownerName)
            .sort((a: any, b: any) => b.year - a.year);

        if (sortedHistory.length > 0) {
            const processedHistory = [];
            let currentRecord = {
                owner_id: ownerNameToIdMap.get(sortedHistory[0].ownerName),
                int_number: sortedHistory[0].int_number,
                deed_xfer_date: sortedHistory[0].deed_xfer_date,
                start_year: sortedHistory[0].year,
                end_year: sortedHistory[0].year
            };

            for (let i = 1; i < sortedHistory.length; i++) {
                const entry = sortedHistory[i];
                const entryOwnerId = ownerNameToIdMap.get(entry.ownerName);
                
                if (entryOwnerId === currentRecord.owner_id &&
                    entry.int_number === currentRecord.int_number &&
                    entry.deed_xfer_date === currentRecord.deed_xfer_date &&
                    entry.year === currentRecord.start_year - 1) {
                    currentRecord.start_year = entry.year;
                } else {
                    processedHistory.push(currentRecord);
                    currentRecord = {
                        owner_id: entryOwnerId,
                        int_number: entry.int_number,
                        deed_xfer_date: entry.deed_xfer_date,
                        start_year: entry.year,
                        end_year: entry.year
                    };
                }
            }
            processedHistory.push(currentRecord);

            const ownershipDbRecords = processedHistory.map(rec => ({
                property_account_number: accountNumber,
                ...rec
            }));
            const { error } = await supabase.from('ownership_history').insert(ownershipDbRecords);
            if (error) return { error };
        }
    }

    const currentYear = new Date().getFullYear();
    if (currentOwners) {
        const currentIntNum = int_number?.trim();
        const currentOwnershipRecords = currentOwners
          .filter((owner: any) => owner.name && ownerNameToIdMap.has(owner.name.trim()))
          .map((owner: any) => ({
            property_account_number: accountNumber,
            owner_id: ownerNameToIdMap.get(owner.name.trim()),
            start_year: currentYear,
            end_year: currentYear,
            ownership_percentage: cleanAndParseNumber(owner.percentage),
            is_primary_owner: owner.isPrimary === true,
            int_number: currentIntNum && currentIntNum.startsWith('INT') ? currentIntNum : null,
            deed_xfer_date: formatAsDate(deed_xfer_date)
          }));

        if (currentOwnershipRecords.length > 0) {
            const { error } = await supabase.from('ownership_history').insert(currentOwnershipRecords);
            if (error) return { error };
        }
    }

    if (marketValueHistory?.length > 0) {
        const valueRecords = marketValueHistory.map((rec: any) => ({
            property_account_number: accountNumber,
            year: cleanAndParseNumber(rec.year),
            total_market_value: cleanAndParseNumber(rec.totalMarketValue)
        }));
        const { error } = await supabase.from('value_history').insert(valueRecords);
        if (error) return { error };
    }

    if (exemptions?.length > 0) {
        const cleanedExemptions = exemptions
            .map((rec: any) => ({
                year: cleanAndParseNumber(rec.year),
                code: rec.code?.trim(),
            }))
            .filter((rec: any) => rec.year !== null && rec.code);

        const exemptionsByCode = new Map<string, number[]>();
        for (const exemption of cleanedExemptions) {
            if (!exemptionsByCode.has(exemption.code)) {
                exemptionsByCode.set(exemption.code, []);
            }
            exemptionsByCode.get(exemption.code)!.push(exemption.year!);
        }

        const allProcessedExemptions = [];

        for (const [code, years] of exemptionsByCode.entries()) {
            years.sort((a, b) => b - a);

            if (years.length > 0) {
                const processedRanges = [];
                let currentRecord = { code: code, start_year: years[0], end_year: years[0] };
                for (let i = 1; i < years.length; i++) {
                    const year = years[i];
                    if (year === currentRecord.start_year - 1) {
                        currentRecord.start_year = year;
                    } else {
                        processedRanges.push(currentRecord);
                        currentRecord = { code: code, start_year: year, end_year: year };
                    }
                }
                processedRanges.push(currentRecord);
                allProcessedExemptions.push(...processedRanges);
            }
        }
        
        if (allProcessedExemptions.length > 0) {
            const exemptionDbRecords = allProcessedExemptions.map(rec => ({
                property_account_number: accountNumber,
                ...rec
            }));
            const { error } = await supabase.from('exemptions').insert(exemptionDbRecords);
            if (error) return { error };
        }
    }
    
    return { error: null };
}

async function saveClerkDataToSupabase(accountNumber: string, documents: any[]) {
    if (!accountNumber || documents.length === 0) {
        return { error: null };
    }

    await supabase.from('property_documents').delete().eq('property_account_number', accountNumber);

    const documentRecords = documents.map(doc => ({
        property_account_number: accountNumber,
        document_type: doc.document_type,
        grantor: doc.grantor,
        grantee: doc.grantee,
        filing_date: formatAsDate(doc.filing_date),
        instrument_number: doc.instrument_number,
        book_and_page: doc.book_and_page,
    }));

    const { error } = await supabase.from('property_documents').insert(documentRecords);
    return { error };
}


runAllScrapers()
  .then(() => console.log('All scraping tasks have been completed.'))
  .catch((error) => console.error('An unhandled error occurred:', error));
