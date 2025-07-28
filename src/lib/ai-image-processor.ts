// src/lib/ai-image-processor.ts

/**
 * Takes an array of base64 encoded image strings, sends them to the Gemini API in a single batch,
 * and returns the combined extracted text.
 * @param images An array of base64 encoded image strings.
 * @returns A promise that resolves to the full extracted text.
 */
export async function getTextFromImages(images: string[]): Promise<string> {
    if (!images || images.length === 0) {
        return '';
    }

    console.log(`  - Extracting text from ${images.length} image pages in a single batch...`);

    // ======================================================================
    // == THE FIX: Explicitly type the 'parts' array to allow different    ==
    // == object shapes, resolving the TypeScript error.                   ==
    // ======================================================================
    const parts: ({ text: string; } | { inlineData: { mimeType: string; data: string; }; })[] = [
        { text: "Extract all text from these document images, in order. Concatenate the text from all pages into a single response." },
    ];

    for (const base64ImageData of images) {
        parts.push({
            inlineData: {
                mimeType: "image/png",
                data: base64ImageData
            }
        });
    }

    const payload = {
        contents: [{ parts }],
    };

    const apiKey = process.env.GOOGLE_API_KEY || "";
    const apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash-latest:generateContent?key=${apiKey}`;

    try {
        const response = await fetch(apiUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });

        if (!response.ok) {
            const errorBody = await response.json();
            console.error("API Error Response:", JSON.stringify(errorBody, null, 2));
            throw new Error(`API request failed with status ${response.status}`);
        }

        const result = await response.json();

        if (result.candidates && result.candidates[0]?.content?.parts[0]?.text) {
            return result.candidates[0].content.parts[0].text;
        } else {
            console.warn("API returned no text content. Response:", JSON.stringify(result, null, 2));
            return "Could not extract text from images.";
        }
    } catch (error) {
        console.error("Error extracting text from images in batch:", error);
        return "Failed to extract text due to a critical error.";
    }
}

/**
 * Takes a block of text, sends it to the Gemini API, and returns a summary.
 * @param text The text to be summarized.
 * @returns A promise that resolves to the AI-generated summary.
 */
export async function summarizeDocumentText(text: string): Promise<string> {
    if (!text.trim()) return "No text to summarize.";
    console.log('  - Summarizing extracted text...');
    
    const payload = {
        contents: [{
            parts: [{ text: `Summarize the following legal document, focusing on the key parties, dates, and purpose of the document:\n\n${text}` }]
        }]
    };
    const apiKey = process.env.GOOGLE_API_KEY || "";
    const apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash-latest:generateContent?key=${apiKey}`;

    try {
        const response = await fetch(apiUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });
        
        if (!response.ok) {
            const errorBody = await response.json();
            console.error("API Error Response during summarization:", JSON.stringify(errorBody, null, 2));
            throw new Error(`API request for summarization failed with status ${response.status}`);
        }

        const result = await response.json();
        if (result.candidates && result.candidates[0]?.content?.parts[0]?.text) {
            return result.candidates[0].content.parts[0].text;
        } else {
            console.warn("API returned no summary content. Response:", JSON.stringify(result, null, 2));
            return "Failed to generate summary.";
        }
    } catch (error) {
        console.error("Error summarizing text:", error);
        throw error;
    }
}