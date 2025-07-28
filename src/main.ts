// src/main.ts

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

// ======================================================================
// == THE FIX: The word "ESTATE" is no longer removed from owner names. ==
// ======================================================================
function normalizeOwnerName(name: string): string {
    return name
        .toUpperCase()
        .replace(/[,.]/g, '') // Remove commas and periods
        .replace(/\s+/g, ' ') // Collapse multiple spaces
        .replace(/&\s*ET\s*AL/g, '') // Remove "& ET AL"
        .trim();
}


const propertiesToScrape = [
    { addressNumber: '9920', streetName: 'Gulf Palm' },
];

async function runAllScrapers() {
    for (const property of propertiesToScrape) {
        try {
            console.log(`\n--- Starting Assessment scraper for ${property.addressNumber} ${property.streetName} ---`);
            const assessmentResult = await runDallasAssessmentScraper(property.addressNumber, property.streetName);

            if (!assessmentResult.success || !assessmentResult.data) {
                console.error(`Assessment scraping failed:`, assessmentResult.error);
                continue;
            }

            console.log('Assessment scraping successful.');
            const parsedLegal = parseLegalDescription(assessmentResult.data.legalDescription);
            
            const { error: saveError } = await saveDataToSupabase(assessmentResult.data, parsedLegal);
            if (saveError) {
                console.error("Failed to save assessment data:", saveError.message);
                continue;
            }

            if (!parsedLegal.subdivision || !parsedLegal.block || !parsedLegal.lot1) {
                console.log("Skipping clerk scraper: Missing required legal description data.");
                continue;
            }
            
            console.log(`--- Starting Clerk scraper ---`);
            const clerkResult = await runClerkScraper({
                lot: parsedLegal.lot1,
                block: parsedLegal.block,
                subdivision: parsedLegal.subdivision,
                city_block: parsedLegal.city_block,
            });

            if (clerkResult.success && clerkResult.data && clerkResult.data.length > 0) {
                console.log(`Clerk scraper processed ${clerkResult.data.length} relevant documents.`);
                await saveClerkDataToSupabase(assessmentResult.data.accountNumber, clerkResult.data);
            } else {
                console.log("Clerk scraper failed or found no relevant documents:", clerkResult.error);
            }
        } catch (error) {
            console.error(`A critical error occurred:`, error);
        }
    }
}

async function saveDataToSupabase(scrapedData: any, parsedLegal: any) {
    const { accountNumber, address, propertyValue, propertyDetails, currentOwners, ownershipHistory, marketValueHistory, exemptions, cad_url } = scrapedData;

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
    currentOwners?.forEach((owner: any) => { if (owner.name) allOwners.set(owner.name.trim(), { address: owner.address?.trim() }); });
    ownershipHistory?.forEach((rec: any) => { const name = (rec.ownerNameAndAddress?.split('\n')[0] || '').trim(); if (name && !allOwners.has(name)) allOwners.set(name, { address: rec.ownerNameAndAddress?.split('\n').slice(1).join(' ').trim() }); });
    if (allOwners.size === 0) { 
        console.log("No owners found in scraped data.");
        return { error: null };
    }
    
    const ownerRecords = Array.from(allOwners.keys()).map(name => ({ owner_name: name }));
    const { data: upsertedOwners, error: ownerError } = await supabase.from('owners').upsert(ownerRecords, { onConflict: 'owner_name' }).select('id, owner_name');
    if (ownerError) return { error: ownerError };
    
    const ownerNameToIdMap = new Map(upsertedOwners!.map(o => [normalizeOwnerName(o.owner_name), o.id]));
    
    await supabase.from('ownership_history').delete().eq('property_account_number', accountNumber);
    await supabase.from('value_history').delete().eq('property_account_number', accountNumber);
    await supabase.from('exemptions').delete().eq('property_account_number', accountNumber);
    
    if (marketValueHistory?.length > 0) {
        const valueRecords = marketValueHistory.map((rec: any) => ({
            property_account_number: accountNumber,
            year: cleanAndParseNumber(rec.year),
            total_market_value: cleanAndParseNumber(rec.totalMarketValue)
        })).filter(r => r.year);
        if(valueRecords.length > 0) await supabase.from('value_history').insert(valueRecords);
    }

    if (exemptions?.length > 0) {
        const cleaned = exemptions.map(e => ({ code: e.code?.trim(), year: cleanAndParseNumber(e.year) })).filter((e): e is { code: string, year: number } => !!e.code && e.year != null);
        const groupedByCode = cleaned.reduce((acc, curr) => {
            (acc[curr.code] = acc[curr.code] || []).push(curr.year);
            return acc;
        }, {} as Record<string, number[]>);

        const recordsToInsert = [];
        for (const code in groupedByCode) {
            const years = groupedByCode[code].sort((a, b) => b - a);
            let end_year = years[0];
            for(let i=0; i < years.length; i++) {
                if (i === years.length - 1 || years[i+1] !== years[i] - 1) {
                    recordsToInsert.push({ property_account_number: accountNumber, code, start_year: years[i], end_year });
                    if (i < years.length - 1) end_year = years[i+1];
                }
            }
        }
        if(recordsToInsert.length > 0) await supabase.from('exemptions').insert(recordsToInsert);
    }
    
    if (ownershipHistory?.length > 0) {
        const cleaned = ownershipHistory
            .map((rec:any) => {
                const ownerName = (rec.ownerNameAndAddress?.split('\n')[0] || '').trim();
                const ownerId = ownerNameToIdMap.get(normalizeOwnerName(ownerName));
                return {
                    owner_id: ownerId,
                    year: cleanAndParseNumber(rec.year),
                };
            })
            .filter((rec): rec is { owner_id: number; year: number } => rec.owner_id != null && rec.year != null);

        const groupedByOwner = cleaned.reduce((acc, curr) => {
            (acc[curr.owner_id] = acc[curr.owner_id] || []).push(curr.year);
            return acc;
        }, {} as Record<number, number[]>);

        const recordsToInsert = [];
        for (const ownerId in groupedByOwner) {
            const years = groupedByOwner[ownerId].sort((a, b) => b - a);
            let end_year = years[0];
            for(let i=0; i < years.length; i++) {
                if (i === years.length - 1 || years[i+1] !== years[i] - 1) {
                    recordsToInsert.push({ 
                        property_account_number: accountNumber, 
                        owner_id: parseInt(ownerId), 
                        start_year: years[i], 
                        end_year 
                    });
                    if (i < years.length - 1) end_year = years[i+1];
                }
            }
        }
        if(recordsToInsert.length > 0) await supabase.from('ownership_history').insert(recordsToInsert);
    }
    
    console.log("Successfully saved all assessment and history data.");
    return { error: null };
}

async function saveClerkDataToSupabase(accountNumber: string, documents: any[]) {
    await supabase.from('property_documents').delete().eq('property_account_number', accountNumber);
    const documentRecords = documents.map(doc => ({
        property_account_number: accountNumber,
        document_type: doc.document_type,
        grantor: doc.grantor,
        grantee: doc.grantee,
        filing_date: formatAsDate(doc.filing_date),
        instrument_number: doc.instrument_number,
        book_and_page: doc.book_and_page,
        summary: doc.summary,
        document_url: doc.documentUrl,
    }));
    const { error } = await supabase.from('property_documents').insert(documentRecords);
    if (error) console.error("Error saving clerk data:", error);
    else console.log("Successfully saved clerk documents with summaries and URLs.");
}

runAllScrapers()
    .then(() => console.log('All scraping tasks have been completed.'))
    .catch((error) => console.error('An unhandled error occurred in the main execution:', error));