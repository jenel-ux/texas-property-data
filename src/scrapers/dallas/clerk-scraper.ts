import { Stagehand, type ConstructorParams } from '@browserbasehq/stagehand';
import { z } from 'zod';

const stagehandConfig = (): ConstructorParams => {
  const proxyUrl = `http://${process.env.OXYLABS_USERNAME}:${process.env.OXYLABS_PASSWORD}@pr.oxylabs.io:7777`;
  return {
    env: 'BROWSERBASE',
    verbose: 1,
    modelName: 'google/gemini-2.5-flash-preview-05-20',
    modelClientOptions: {
      apiKey: process.env.GOOGLE_API_KEY,
    },
    proxy: proxyUrl,
  } as any;
};

interface ClerkScraperInput {
    lot: string | null;
    block: string | null;
    city_block: string | null;
    subdivision: string | null;
}

async function runClerkScraper(input: ClerkScraperInput) {
  let stagehand: Stagehand | null = null;
  try {
    console.log('Initializing Clerk Scraper...');
    stagehand = new Stagehand(stagehandConfig());
    await stagehand.init();
    console.log('Clerk Scraper initialized successfully.');

    const page = stagehand.page;
    if (!page) {
      throw new Error('Failed to get page instance from Stagehand');
    }

    // --- Using the reliable URL construction method ---
    const today = new Date();
    const endDate = `${today.getFullYear()}${(today.getMonth() + 1).toString().padStart(2, '0')}${today.getDate().toString().padStart(2, '0')}`;
    const startDate = '20000101';

    const subdivision = encodeURIComponent(input.subdivision || '');
    const lot = encodeURIComponent(input.lot || '');
    const block = encodeURIComponent(input.block || '');
    const cityBlock = encodeURIComponent(input.city_block || '');

    const searchUrl = `https://dallas.tx.publicsearch.us/results?department=RP&searchType=advancedSearch&recordedDateRange=${startDate}%2C${endDate}&lot=${lot}&block=${block}&block2=${cityBlock}&legalDescription=${subdivision}`;
    
    console.log(`Navigating directly to search results: ${searchUrl}`);
    await page.goto(searchUrl);
    
    await page.waitForSelector('xpath=/html[1]/body[1]/div[2]/article[1]/div[1]/div[1]/div[2]/div[1]/table[1]/tbody[1]/tr', { timeout: 15000 });

    const documents = await page.extract({
        instruction: "From the search results table, extract a list of all documents. For each document, get the Document Type, Grantor, Grantee, Filing Date, Instrument #, Book/Page, and the full Legal Description text.",
        schema: z.object({
            documents: z.array(z.object({
                document_type: z.string().optional(),
                grantor: z.string().optional(),
                grantee: z.string().optional(),
                filing_date: z.string().optional(),
                instrument_number: z.string().optional(),
                book_and_page: z.string().optional(),
                legal_description: z.string().optional(), // Added field for filtering
            })).optional()
        })
    });

    console.log('Clerk workflow completed successfully.');
    return { success: true, data: { ...documents, searchUrl } };

  } catch (error) {
    console.error('Clerk workflow failed:', error);
    return { success: false, error };
  } finally {
    if (stagehand) {
      console.log('Closing Stagehand connection.');
      await stagehand.close();
    }
  }
}

export default runClerkScraper;
