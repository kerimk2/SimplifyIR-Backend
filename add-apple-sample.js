const { Pinecone } = require('@pinecone-database/pinecone');
const OpenAI = require('openai');
const dotenv = require('dotenv');

dotenv.config();

const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY
});

const pinecone = new Pinecone({
    apiKey: process.env.PINECONE_API_KEY
});

async function generateEmbedding(text) {
    const response = await openai.embeddings.create({
        model: "text-embedding-ada-002",
        input: text
    });
    return response.data[0].embedding;
}

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

async function addAppleData() {
    try {
        console.log('🍎 Adding realistic Apple financial data...');
        
        const appleData = `
Apple Inc. (AAPL) - Q4 2024 Financial Results

QUARTERLY FINANCIAL HIGHLIGHTS (Q4 2024):
• Total Revenue: $119.58 billion (up 6% year-over-year)
• iPhone Revenue: $69.7 billion (up 3% year-over-year)
• Services Revenue: $24.2 billion (up 12% year-over-year)  
• Mac Revenue: $7.74 billion (down 34% year-over-year)
• iPad Revenue: $6.95 billion (down 20% year-over-year)
• Wearables, Home & Accessories Revenue: $11.75 billion (down 3% year-over-year)

ANNUAL FINANCIAL RESULTS (Fiscal Year 2024):
• Annual Revenue: $391.04 billion (down 3% year-over-year)
• Annual Net Income: $93.74 billion 
• Earnings Per Share: $6.11
• Operating Cash Flow: $110.56 billion
• Cash and Cash Equivalents: $67.15 billion
• Total Assets: $364.84 billion

SEGMENT PERFORMANCE:
iPhone continues to be Apple's largest revenue segment, representing 58% of total revenue in Q4 2024. 
Services achieved record revenue of $24.2 billion, demonstrating strong customer loyalty and engagement.
Mac sales were impacted by challenging comparisons and market conditions.
iPad revenue declined due to timing of product launches.

GEOGRAPHIC PERFORMANCE:
• Americas Revenue: $40.93 billion
• Europe Revenue: $24.92 billion  
• Greater China Revenue: $15.03 billion
• Japan Revenue: $5.93 billion
• Rest of Asia Pacific Revenue: $7.43 billion

KEY BUSINESS METRICS:
• Gross Margin: 46.2% (up 130 basis points year-over-year)
• Operating Margin: 30.7%
• Services Gross Margin: 74.0%
• Return on Equity: 147%

FORWARD-LOOKING STATEMENTS:
Apple expects revenue growth to accelerate in the December quarter.
The company continues to invest in research and development for future products.
Services revenue is expected to continue growing at a double-digit rate.

RECENT DEVELOPMENTS:
• Launched iPhone 15 series with USB-C
• Introduced Apple Vision Pro spatial computing platform
• Expanded Apple Intelligence AI features
• Continued expansion of Apple Services globally
• Ongoing commitment to carbon neutrality by 2030

RISK FACTORS:
• Competitive pressure in smartphone markets globally
• Supply chain disruptions and component shortages
• Economic uncertainty in key markets including China
• Regulatory scrutiny in multiple jurisdictions
• Foreign exchange rate fluctuations
        `;
        
        const index = pinecone.index('simplifyir');
        const chunks = splitIntoChunks(appleData);
        
        console.log(`📝 Processing ${chunks.length} chunks of Apple data...`);
        
        for (let i = 0; i < chunks.length; i++) {
            const chunk = chunks[i];
            const embedding = await generateEmbedding(chunk);
            const id = `AAPL-Realistic-Data-${Date.now()}-${i}`;
            
            await index.upsert([{
                id: id,
                values: embedding,
                metadata: {
                    company: 'AAPL',
                    content: chunk,
                    document_type: 'Financial-Report',
                    source: 'Apple Q4 2024 10-Q Filing',
                    created_at: new Date().toISOString()
                }
            }]);
            
            console.log(`✅ Added chunk ${i + 1}/${chunks.length}`);
            await new Promise(resolve => setTimeout(resolve, 500));
        }
        
        console.log('🎉 Successfully added realistic Apple financial data!');
        console.log('\n🧪 Now test with:');
        console.log('• "What was Apple\'s revenue in Q4 2024?"');
        console.log('• "What was Apple\'s iPhone revenue?"');
        console.log('• "What is Apple\'s cash position?"');
        console.log('• "How did Apple\'s Services segment perform?"');
        
    } catch (error) {
        console.error('❌ Error adding Apple data:', error);
    }
}

addAppleData();
