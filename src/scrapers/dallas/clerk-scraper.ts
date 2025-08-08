// src/scrapers/dallas/clerk-scraper.ts

import { Stagehand, type ConstructorParams } from '@browserbasehq/stagehand';
import { z } from 'zod';
import { getTextFromImages, summarizeDocumentText } from '../../lib/ai-image-processor.js';

const stagehandConfig = (): ConstructorParams => {
    const proxyUrl = `http://${process.env.OXYLABS_USERNAME}:${process.env.OXYLABS_PASSWORD}@pr.oxylabs.io:7777`;
    return {
        env: 'BROWSERBASE',
        verbose: 1,
        modelName: 'google/gemini-2.5-flash-preview-05-20',
        modelClientOptions: { apiKey: process.env.GOOGLE_API_KEY },
        localBrowserLaunchOptions: { 
            proxy: { server: proxyUrl },
            timeout: 60000, // 60 second timeout
        },
        // Add global timeout settings
        browserbaseSessionCreateParams: {
            timeout: 300, // 5 minutes session timeout
        },
    } as any;
};

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

interface ClerkScraperInput {
    lot: string;
    block: string;
    subdivision: string;
    city_block: string | null;
}

async function runClerkScraper(targetLegal: ClerkScraperInput) {
    let stagehand: Stagehand | null = null;
    let stagehandClosed = false;
    const safeClose = async () => {
        if (stagehandClosed) return;
        stagehandClosed = true;
        try { await stagehand?.close(); } catch {}
    };

    try {
        stagehand = new Stagehand(stagehandConfig());
        await stagehand.init();
        let page = stagehand.page!;
        // Set conservative defaults to reduce flakiness
        try {
            page.setDefaultTimeout?.(15000);
            page.setDefaultNavigationTimeout?.(30000);
        } catch {}

        const today = new Date();
        const endDate = `${today.getFullYear()}${(today.getMonth() + 1).toString().padStart(2, '0')}${today.getDate().toString().padStart(2, '0')}`;
        const searchUrl = `https://dallas.tx.publicsearch.us/results?department=RP&searchType=advancedSearch&recordedDateRange=20000101%2C${endDate}&lot=${encodeURIComponent(targetLegal.lot)}&block=${encodeURIComponent(targetLegal.block)}&block2=${encodeURIComponent(targetLegal.city_block || '')}&legalDescription=${encodeURIComponent(targetLegal.subdivision)}`;
        
        await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
        await sleep(Math.random() * 2000 + 5000); 
        await page.waitForSelector('table tbody tr', { timeout: 30000 });

        const { documents } = await page.extract({
            instruction: "From the search results table, extract an array of all documents shown.",
            schema: z.object({
                documents: z.array(z.object({
                    document_type: z.string().optional(),
                    grantor: z.string().optional(),
                    grantee: z.string().optional(),
                    filing_date: z.string().optional(),
                    instrument_number: z.string().optional(),
                    book_and_page: z.string().optional(),
                    legal_description: z.string().optional(),
                }))
            })
        });

        const filteredDocuments = documents.filter((doc: any) => {
            const docLegal = doc.legal_description?.toUpperCase() || '';
            const hasLot = new RegExp(`\\b(LOT|LT):?\\s*${targetLegal.lot}\\b`).test(docLegal);
            const hasBlock = new RegExp(`\\b(BLOCK|BLK):?\\s*${targetLegal.block}\\b`).test(docLegal);
            return hasLot && hasBlock;
        });

        console.log(`Found ${documents.length} total documents, filtered down to ${filteredDocuments.length} relevant documents.`);
        if (filteredDocuments.length === 0) return { success: true, data: [] };

        const processedDocs: any[] = [];
        for (const [index, doc] of filteredDocuments.entries()) {
            let summary = 'Summary could not be generated.';
            let documentUrl: string | null = null;
            const isClosedErr = (err: unknown) => /Target .*closed|Session closed|context has been closed/i.test(String((err as any)?.message || err));

            const processOnce = async () => {
                console.log(`Processing document ${index + 1}/${filteredDocuments.length}: ${doc.instrument_number}`);
                const originalIndex = documents.findIndex((d: any) => d.instrument_number === doc.instrument_number);
                // Click the row and wait for the image viewer
                await page.locator(`table tbody tr:nth-child(${originalIndex + 1})`).click({ timeout: 15000 });
                const imageSelector = 'svg image';
                await page.waitForSelector(imageSelector, { timeout: 60000 });
                documentUrl = page.url();

                const { pageCount } = await page.extract({
                    instruction: "Find the page count text on the page (e.g., '1 of 6') and return only the total number of pages as an integer.",
                    schema: z.object({ pageCount: z.number().default(1) })
                });

                const images: string[] = [];
                for (let i = 1; i <= pageCount; i++) {
                    const imgBuffer = await page.locator(imageSelector).first().screenshot();
                    images.push(imgBuffer.toString('base64'));
                    if (i < pageCount) {
                        const nextPageButton = page.locator('button:has(img[alt="Go To Next Page"])');
                        await nextPageButton.click({ timeout: 15000 });
                        await sleep(1000);
                    }
                }
                const extractedText = await getTextFromImages(images);
                summary = await summarizeDocumentText(extractedText);
            };

            try {
                await processOnce();
            } catch (e) {
                console.error(`Failed to process images/summary for ${doc.instrument_number}:`, (e as Error).message);
                if (isClosedErr(e)) {
                    // Recreate session and retry once from search results
                    console.log('Detected closed page/context. Recreating session and retrying once...');
                    await safeClose();
                    stagehand = new Stagehand(stagehandConfig());
                    await stagehand.init();
                    stagehandClosed = false; // new session
                    page = stagehand.page!;
                    try {
                        page.setDefaultTimeout?.(15000);
                        page.setDefaultNavigationTimeout?.(30000);
                    } catch {}
                    // Navigate back to search results and locate the same document again
                    await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
                    await sleep(Math.random() * 2000 + 5000);
                    await page.waitForSelector('table tbody tr', { timeout: 30000 });
                    try {
                        await processOnce();
                    } catch (e2) {
                        console.error(`Retry also failed for ${doc.instrument_number}:`, (e2 as Error).message);
                    }
                }
            } finally {
                processedDocs.push({ ...doc, summary, documentUrl });
                if (index < filteredDocuments.length - 1) {
                    try {
                        await page.goBack({ waitUntil: 'domcontentloaded' });
                    } catch {}
                    await sleep(Math.random() * 1000 + 2000);
                }
            }
        }
        return { success: true, data: processedDocs };

    } catch (error) {
        return { success: false, error: (error as Error).message };
    } finally {
        await safeClose();
    }
}

export default runClerkScraper;