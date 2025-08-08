// src/scrapers/dallas/assessment-scraper.ts

import { Stagehand, ConstructorParams } from '@browserbasehq/stagehand';
import { z } from 'zod';

// Retry helper function
async function withRetry<T>(
    fn: () => Promise<T>, 
    retries: number = 2, 
    delay: number = 3000
): Promise<T> {
    for (let i = 0; i <= retries; i++) {
        try {
            return await fn();
        } catch (error) {
            if (i === retries) throw error;
            console.log(`Attempt ${i + 1} failed, retrying in ${delay}ms...`);
            await new Promise(resolve => setTimeout(resolve, delay));
        }
    }
    throw new Error('All retry attempts failed');
}

const stagehandConfig = (): ConstructorParams => {
    // Construct the proxy URL from environment variables
    const proxyUrl = `http://${process.env.OXYLABS_USERNAME}:${process.env.OXYLABS_PASSWORD}@pr.oxylabs.io:7777`;

    return {
        env: 'BROWSERBASE',
        verbose: 2,
        modelName: 'google/gemini-2.5-flash-preview-05-20',
        modelClientOptions: {
            apiKey: process.env.GOOGLE_API_KEY,
        },
        // Add the proxy configuration
        localBrowserLaunchOptions: { 
            proxy: { server: proxyUrl },
            timeout: 60000, // 60 second timeout
        },
        // Add global timeout settings
        browserbaseSessionCreateParams: {
            timeout: 300, // 5 minutes session timeout
        },
    };
};

async function runDallasAssessmentScraper(addressNumber: string, streetName: string) {
    let stagehand: Stagehand | null = null;
    try {
        console.log('Initializing Stagehand...');
        stagehand = new Stagehand(stagehandConfig());
        await stagehand.init();
        console.log('Stagehand initialized successfully.');

        const page = stagehand.page;
        if (!page) {
            throw new Error('Failed to get page instance from Stagehand');
        }

        await page.goto('https://www.dallascad.org/searchaddr.aspx', { timeout: 60000 });
        await page.act({
            description: `type '${addressNumber}' into the Address Number field`,
            method: 'fill',
            arguments: [addressNumber],
            selector: 'xpath=/html[1]/body[1]/form[1]/table[2]/tbody[1]/tr[1]/td[2]/table[1]/tbody[1]/tr[1]/td[1]/table[1]/tbody[1]/tr[2]/td[1]/input[1]',
        });
        await page.act({
            description: `type '${streetName}' into the Street Name field`,
            method: 'fill',
            arguments: [streetName],
            selector: 'xpath=/html[1]/body[1]/form[1]/table[2]/tbody[1]/tr[1]/td[2]/table[1]/tbody[1]/tr[1]/td[1]/table[1]/tbody[1]/tr[2]/td[3]/input[1]',
        });
        await page.act({
            description: 'click the Search button',
            method: 'click',
            arguments: [],
            selector: 'xpath=/html[1]/body[1]/form[1]/table[2]/tbody[1]/tr[1]/td[2]/table[1]/tbody[1]/tr[1]/td[1]/table[1]/tbody[1]/tr[6]/td[3]/input[1]',
        });
        // Wait for search results to load
        await page.waitForTimeout(5000);
        
        // Try to click the property address link - multiple approaches
        try {
            // First try: Look for link with the street name and AcctDetailRes in href
            await page.act({
                description: `click the property address link containing '${streetName.toUpperCase()}'`,
                method: 'click',
                arguments: [],
                selector: `//a[contains(text(),'${streetName.toUpperCase()}') and contains(@href,'AcctDetailRes')]`,
            });
        } catch (error) {
            console.log('First selector failed, trying alternative...');
            // Second try: Look for any link containing the street name
            await page.act({
                description: `click the property address link containing '${streetName.toUpperCase()}'`,
                method: 'click',
                arguments: [],
                selector: `//a[contains(text(),'${streetName.toUpperCase()}')]`,
            });
        }

        // After clicking, explicitly wait for the property details URL pattern
        // Example: https://www.dallascad.org/AcctDetailRes.aspx?ID=some_id
        const acctDetailUrlPattern = /AcctDetailRes\.aspx\?ID=/i;
        try {
            await page.waitForURL(acctDetailUrlPattern, { timeout: 20000 });
        } catch {
            // Fallback: directly navigate to the first matching result link if URL didn't change
            const acctLink = page.locator("//a[contains(@href,'AcctDetailRes.aspx?ID=')]").first();
            const href = await acctLink.getAttribute('href').catch(() => null);
            if (href) {
                const absoluteUrl = href.startsWith('http') ? href : new URL(href, 'https://www.dallascad.org/').toString();
                await page.goto(absoluteUrl, { timeout: 60000 });
                await page.waitForLoadState('domcontentloaded', { timeout: 30000 });
            }
        }

        const propertyUrl = page.url();

        // Wait for the page to fully load
        await page.waitForTimeout(5000);
        
        // First, let's try to extract the legal description using a more specific approach
        const legalDescriptionData = await withRetry(async () => {
            return await page.extract({
                instruction: 'Find and extract the legal description text. Look for any section that contains subdivision names, block numbers (BLK), and lot numbers (LT). The legal description is usually displayed in a multi-line format. Search for text that looks like "ST AUGUSTINE HIGHLANDS" or "BLK N/6757" or "LT 8". Also look for any text that contains "Legal Desc" or "Legal Description" in the page. If you find any text that contains "ST AUGUSTINE HIGHLANDS" or "BLK N/6757" or "LT 8", extract it as the legal description.',
                schema: z.object({
                    legalDescription: z.string().optional().describe("The full, multi-line text from the legal description section"),
                }),
            });
        });

        const mainPageData = await withRetry(async () => {
            return await page.extract({
                instruction: 'From the property details page, extract the address, account number, property value, property details, and a list of ALL current owners. For each owner, get their name, address, and ownership percentage.',
                schema: z.object({
                    address: z.string().optional(),
                    accountNumber: z.string().optional(),
                    int_number: z.string().optional().describe("The line starting with 'INT' from the 'Legal Desc (Current)' section"),
                    deed_xfer_date: z.string().optional().describe("The date from the 'Deed Transfer Date' line"),
                    propertyValue: z.object({
                        improvementValue: z.string().optional(),
                        landValue: z.string().optional(),
                        totalMarketValue: z.string().optional(),
                    }).optional(),
                    propertyDetails: z.object({
                        yearBuilt: z.string().optional(),
                        livingArea: z.string().optional(),
                    }).optional(),
                    currentOwners: z.array(z.object({
                        name: z.string(),
                        address: z.string().optional(),
                        percentage: z.string().optional(),
                        isPrimary: z.boolean().optional().describe("Set to true only for the owner listed under the main 'Owner' heading"),
                    })).optional(),
                }),
            });
        });

        // Combine the data
        const combinedData = {
            ...mainPageData,
            legalDescription: legalDescriptionData.legalDescription || null,
        };

        await page.act({
            description: 'click the History link',
            method: 'click',
            arguments: [],
            selector: 'xpath=/html[1]/body[1]/form[1]/table[2]/tbody[1]/tr[2]/td[1]/div[6]/p[1]/a[1]',
        });

        const ownershipData = await page.extract({
            instruction: 'From the history page, extract the ownership history table. For each row, get the year, the full owner name and address, the INT number (line starting with INT), and the Deed Transfer Date.',
            schema: z.object({
                ownershipHistory: z.array(z.object({
                    year: z.string().optional(),
                    ownerNameAndAddress: z.string().optional().describe("The full text block containing the owner's name and address"),
                    int_number: z.string().optional().describe("The line starting with 'INT' from the 'Legal Description' column"),
                    deed_xfer_date: z.string().optional().describe("The date from the 'Deed Transfer Date' line in the 'Legal Description' column"),
                })).optional(),
            }),
        });
        const marketValueData = await page.extract({
            instruction: 'From the history page, extract the market value history table.',
            schema: z.object({
                marketValueHistory: z.array(z.object({
                    year: z.string().optional(),
                    totalMarketValue: z.string().optional(),
                })).optional(),
            }),
        });
        const exemptionsData = await page.extract({
            instruction: 'From the history page, extract the exemptions table with the year and code for each entry.',
            schema: z.object({
                exemptions: z.array(z.object({
                    year: z.string().optional(),
                    code: z.string().optional(),
                })).optional(),
            }),
        });

        console.log('Workflow completed successfully.');
        return { success: true, data: { ...combinedData, ...ownershipData, ...marketValueData, ...exemptionsData, cad_url: propertyUrl } };

    } catch (error) {
        console.error('Workflow failed:', error);
        // This critical fix prevents the circular structure error
        return { success: false, error: (error as Error).message };
    } finally {
        if (stagehand) {
            console.log('Closing Stagehand connection.');
            await stagehand.close();
        }
    }
}

// Renamed to match the import in main.ts
export default runDallasAssessmentScraper;