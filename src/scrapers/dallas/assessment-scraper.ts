import { Stagehand, ConstructorParams } from '@browserbasehq/stagehand';
import { z } from 'zod';

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
    proxy: proxyUrl,
  };
};

async function runWorkflow(addressNumber: string, streetName: string) {
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

    // ... (navigation and search actions remain the same)
    await page.goto('https://www.dallascad.org/searchaddr.aspx');
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
    await page.act({
      description: `click the property address link containing '${streetName.toUpperCase()}'`,
      method: 'click',
      arguments: [],
      selector: `//a[contains(text(),'${streetName.toUpperCase()}')]`,
    });

    // --- Capture the URL after navigation ---
    const propertyUrl = page.url();

    // --- First Extraction (Main Page) ---
    const extractedData7 = await page.extract({
        instruction: 'From the property details page, extract the address, account number, property value, property details, and a list of ALL current owners. For each owner, get their name, address, and ownership percentage. Also, from the "Legal Desc (Current)" section, extract the full, multi-line legal description text, the INT number (the line starting with INT), and the Deed Transfer Date.',
        schema: z.object({
            address: z.string().optional(),
            accountNumber: z.string().optional(),
            legalDescription: z.string().optional().describe("The full, multi-line text from the 'Legal Desc (Current)' section"),
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

    // Click the "History" link to navigate to the next page
    await page.act({
      description: 'click the History link',
      method: 'click',
      arguments: [],
      selector: 'xpath=/html[1]/body[1]/form[1]/table[2]/tbody[1]/tr[2]/td[1]/div[6]/p[1]/a[1]',
    });

    // --- Second Extraction Step (History Page) ---
    // (This section remains unchanged)
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
    // Add the captured URL to the returned data
    return { success: true, data: { ...extractedData7, ...ownershipData, ...marketValueData, ...exemptionsData, cad_url: propertyUrl } };

  } catch (error) {
    console.error('Workflow failed:', error);
    return { success: false, error };
  } finally {
    if (stagehand) {
      console.log('Closing Stagehand connection.');
      await stagehand.close();
    }
  }
}

export default runWorkflow;
