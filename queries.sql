-- Sample queries to explore your scraped data in Supabase

-- 1. View all properties
SELECT * FROM properties;

-- 2. View property with owner information
SELECT 
    p.address,
    p.total_market_value,
    p.year_built,
    o.owner_name
FROM properties p
LEFT JOIN ownership_history oh ON p.account_number = oh.property_account_number
LEFT JOIN owners o ON oh.owner_id = o.id
WHERE oh.end_year IS NULL OR oh.end_year >= EXTRACT(YEAR FROM CURRENT_DATE);

-- 3. View value history for a specific property
SELECT 
    p.address,
    vh.year,
    vh.total_market_value
FROM value_history vh
JOIN properties p ON vh.property_account_number = p.account_number
WHERE p.address LIKE '%GULF PALM%'
ORDER BY vh.year DESC;

-- 4. View all owners
SELECT * FROM owners;

-- 5. View ownership history
SELECT 
    p.address,
    o.owner_name,
    oh.start_year,
    oh.end_year
FROM ownership_history oh
JOIN properties p ON oh.property_account_number = p.account_number
JOIN owners o ON oh.owner_id = o.id
ORDER BY p.address, oh.start_year DESC;

-- 6. View exemptions
SELECT 
    p.address,
    e.code,
    e.start_year,
    e.end_year
FROM exemptions e
JOIN properties p ON e.property_account_number = p.account_number
ORDER BY p.address, e.start_year DESC;

-- 7. View property documents (if any)
SELECT 
    p.address,
    pd.document_type,
    pd.filing_date,
    pd.grantor,
    pd.grantee
FROM property_documents pd
JOIN properties p ON pd.property_account_number = p.account_number
ORDER BY pd.filing_date DESC;
