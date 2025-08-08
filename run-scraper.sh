#!/bin/bash

# Texas Property Scraper Runner
# Usage: ./run-scraper.sh

# Set the working directory
cd "$(dirname "$0")"

# Load environment variables
if [ -f .env ]; then
    export $(cat .env | grep -v '^#' | xargs)
else
    echo "Error: .env file not found"
    exit 1
fi

# Create logs directory if it doesn't exist
mkdir -p logs

# Run the scraper with timestamp
echo "Starting Texas Property Scraper at $(date)" | tee -a logs/scraper.log
npm start 2>&1 | tee -a logs/scraper.log

# Check exit status
if [ $? -eq 0 ]; then
    echo "Scraper completed successfully at $(date)" | tee -a logs/scraper.log
else
    echo "Scraper failed at $(date)" | tee -a logs/scraper.log
    exit 1
fi
