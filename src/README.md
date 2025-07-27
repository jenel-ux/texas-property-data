# Texas Property Data Scraper

This project scrapes property data from Dallas, Harris, and Tarrant counties.

## How to Run

1.  Install dependencies with `npm install`.
2.  Run the scraper with `npm start`.

Functional Description (Dallas)
This is a multi-stage TypeScript application designed to gather comprehensive property data from various Texas public record websites. It leverages headless browser automation via the @browserbasehq/stagehand library, utilizes the Google Gemini AI API for advanced data extraction and document summarization, and stores the final, normalized data in a Supabase PostgreSQL database.

The project is structured with self-contained, single-purpose scrapers that are orchestrated by a main control script, ensuring a robust and maintainable workflow.

Core Technologies
TypeScript & Node.js

@browserbasehq/stagehand: For AI-powered headless browser automation.

Google Gemini AI API: For all data extraction, parsing, and summarization tasks.

Supabase: For PostgreSQL database storage.

Zod: For schema definition and validation of AI-extracted data.

***End-to-End Workflow 
The application executes a precise, multi-step data pipeline for each target property:

1.  **Initiate Assessment Scrape**: The main orchestrator, `main.ts`, begins the process by calling the `assessment-scraper`.
2.  **Extract Assessment Data**: The `assessment-scraper` independently connects to the Dallas County Appraisal District (DCAD) website, navigates the site, and uses AI to extract all primary property and historical data, including a structured legal description (`lot`, `block`, etc.).
3.  **Save Assessment Data**: `main.ts` receives the complete data object from the scraper and saves all the historical information to the appropriate tables in Supabase (`properties`, `owners`, `ownership_history`, etc.).
4.  **Initiate Clerk Scrape**: `main.ts` then calls the `clerk-scraper`, passing it the structured legal description.
5.  **Extract and Filter Clerk Data**: The self-contained `clerk-scraper` then executes its entire workflow:
    * It connects to the Dallas County Clerk's website.
    * It extracts the metadata for all documents found.
    * It **internally filters** this list down to find only the documents that are an exact match for the target property.
6.  **Capture and Process Images**: For each of the filtered, relevant documents, the `clerk-scraper` performs an interactive loop:
    * It clicks to open the document viewer.
    * It uses AI to determine the page count.
    * It captures a screenshot of every page.
    * It calls the `ai-image-processor` library to perform OCR and generate an AI summary.
7.  **Final Data Save**: The `clerk-scraper` returns a complete array of the processed documents, including their summaries. `main.ts` receives this final data and saves it to the `property_documents` table, completing the workflow.