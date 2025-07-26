const { Pinecone } = require('@pinecone-database/pinecone');
const OpenAI = require('openai');
const dotenv = require('dotenv');

// Load environment variables
dotenv.config();

// Initialize services
const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY
});

const pinecone = new Pinecone({
    apiKey: process.env.PINECONE_API_KEY
});

// Generate embeddings
async function generateEmbedding(text) {
    try {
        const response = await openai.embeddings.create({
            model: "text-embedding-ada-002",
            input: text
        });
        return response.data[0].embedding;
    } catch (error) {
        console.error('Error generating embedding:', error);
        throw error;
    }
}

// Split text into chunks
function splitIntoChunks(text, chunkSize = 800) {
    const words = text.split(' ');
    const chunks = [];
    
    for (let i = 0; i < words.length; i += chunkSize) {
        const chunk = words.slice(i, i + chunkSize).join(' ');
        if (chunk.trim().length > 0) {
            chunks.push(chunk);
        }
    }
    
    return chunks;
}

// Process and store document
async function addDocumentToDatabase(content, company, docType, source) {
    try {
        console.log(`📄 Processing ${source} for ${company}...`);
        
        const index = pinecone.index('simplifyir');
        
        // Split content into chunks
        const chunks = splitIntoChunks(content);
        console.log(`📝 Created ${chunks.length} chunks`);
        
        // Process chunks in batches
        for (let i = 0; i < chunks.length; i++) {
            const chunk = chunks[i];
            
            // Generate embedding
            const embedding = await generateEmbedding(chunk);
            
            // Create unique ID
            const id = `${company}-${docType}-${Date.now()}-${i}`;
            
            // Store in Pinecone
            await index.upsert([{
                id: id,
                values: embedding,
                metadata: {
                    company: company,
                    content: chunk,
                    document_type: docType,
                    source: source,
                    created_at: new Date().toISOString()
                }
            }]);
            
            console.log(`✅ Processed chunk ${i + 1}/${chunks.length}`);
            
            // Small delay to avoid rate limits
            await new Promise(resolve => setTimeout(resolve, 500));
        }
        
        console.log(`🎉 Successfully added ${source} for ${company}`);
        return true;
        
    } catch (error) {
        console.error(`❌ Error processing ${source}:`, error);
        return false;
    }
}

// Sample company data
const sampleData = {
    'DEMO': {
        content: `
        Demo Company Inc. (DEMO) - Q3 2024 Financial Results and Business Update
        
        FINANCIAL HIGHLIGHTS:
        • Revenue: $2.5 billion (up 15% year-over-year)
        • Net Income: $450 million (up 20% year-over-year)
        • Earnings Per Share: $3.25 (vs $2.70 prior year)
        • Cash and Cash Equivalents: $1.8 billion
        • Total Assets: $8.2 billion
        • Stockholders' Equity: $5.1 billion
        • Operating Cash Flow: $650 million (up 18% year-over-year)
        
        BUSINESS HIGHLIGHTS:
        • Successfully launched AI-powered product suite "DemoAI Pro"
        • Expanded operations into European markets (UK, Germany, France)
        • Signed strategic partnership with Fortune 500 technology company
        • R&D investment increased by 25% to $380 million
        • Customer base grew to 2.5 million active users
        • Employee count reached 8,500 (up 12% from prior year)
        
        SEGMENT PERFORMANCE:
        Software Division: $1.6 billion revenue (64% of total, +22% growth)
        Services Division: $650 million revenue (26% of total, +8% growth)
        Hardware Division: $250 million revenue (10% of total, +5% growth)
        
        FORWARD-LOOKING STATEMENTS:
        Management expects continued growth in Q4 2024, with revenue guidance of $2.6-2.8 billion.
        The company anticipates margin expansion due to operational efficiency improvements.
        Full-year 2024 revenue is expected to reach $9.8-10.2 billion.
        
        KEY METRICS:
        • Gross Margin: 72% (improved from 70% prior year)
        • Operating Margin: 28% (improved from 26% prior year)
        • Return on Equity: 18%
        • Debt-to-Equity Ratio: 0.25
        • Book Value per Share: $42.50
        
        RISK FACTORS:
        • Competitive pressure in core software markets
        • Regulatory changes in data privacy and AI governance
        • Supply chain disruptions affecting hardware division
        • Currency exchange rate fluctuations in international markets
        • Cybersecurity threats and data protection requirements
        
        RECENT DEVELOPMENTS:
        • Acquired AI startup TechInnovate for $150 million
        • Launched new cloud infrastructure services
        • Received ISO 27001 certification for data security
        • Established new development center in Austin, Texas
        • Board approved $500 million share buyback program
        `,
        source: 'Q3 2024 10-Q Filing'
    },
    
    'AAPL': {
        content: `
        Apple Inc. (AAPL) - Sample Financial Information
        
        RECENT QUARTERLY HIGHLIGHTS:
        • iPhone revenue continues to be the largest segment
        • Services revenue showing strong growth trajectory
        • Mac and iPad segments performing well
        • Strong performance in international markets
        • Supply chain optimizations improving margins
        
        KEY PRODUCTS AND SERVICES:
        • iPhone: Flagship smartphone product line
        • Mac: Desktop and laptop computers
        • iPad: Tablet computing devices
        • Apple Watch: Wearable technology
        • Services: App Store, iCloud, Apple Music, Apple TV+
        
        BUSINESS STRATEGY:
        • Focus on innovation and premium user experience
        • Expanding services ecosystem
        • Investment in research and development
        • Sustainable and environmentally conscious operations
        • Strong retail and online presence globally
        
        Note: This is sample data for demonstration purposes only.
        `,
        source: 'Sample Apple Data'
    }
};

// Main function to add all sample data
async function addAllSampleData() {
    console.log('🚀 Starting to add sample data...');
    
    try {
        for (const [company, data] of Object.entries(sampleData)) {
            await addDocumentToDatabase(
                data.content,
                company,
                'Financial-Report',
                data.source
            );
        }
        
        console.log('🎉 All sample data added successfully!');
        console.log('\nYou can now test your AI chat with questions like:');
        console.log('• "What was DEMO company\'s revenue in Q3?"');
        console.log('• "What are DEMO\'s main business segments?"');
        console.log('• "What is Apple\'s main strategy?"');
        
    } catch (error) {
        console.error('❌ Failed to add sample data:', error);
    }
}

// Run if called directly
if (require.main === module) {
    addAllSampleData();
}
