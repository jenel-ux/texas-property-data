import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_ANON_KEY;

if (!supabaseUrl || !supabaseKey) {
  throw new Error("Supabase URL and Key are required in the .env file");
}
const supabase = createClient(supabaseUrl, supabaseKey);

async function clearDatabase() {
  console.log('--- Clearing existing data from database ---');
  
  // Important: Delete from tables with foreign keys first to avoid errors.
  const tablesToDelete = ['ownership_history', 'value_history', 'exemptions'];

  for (const table of tablesToDelete) {
    // Deletes all rows in the table
    const { error } = await supabase.from(table).delete().neq('id', 0); 
    if (error) {
      console.error(`Error clearing ${table}:`, error.message);
    } else {
      console.log(`Successfully cleared ${table}.`);
    }
  }

  // Now delete from the parent tables
  const parentTables = ['properties', 'owners'];
   for (const table of parentTables) {
    const { error } = await supabase.from(table).delete().neq('id', 0);
    if (error) {
      console.error(`Error clearing ${table}:`, error.message);
    } else {
      console.log(`Successfully cleared ${table}.`);
    }
  }
  
  console.log('--- Database clearing complete ---');
}

// --- Script Execution ---
clearDatabase()
  .then(() => console.log('Database has been cleared successfully.'))
  .catch((error) => console.error('An error occurred while clearing the database:', error));
