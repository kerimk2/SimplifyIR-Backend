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

async function debugSearch(question, company) {
    try {
        console.log(`🔍 Debugging search for: "${question}" in ${company} documents\n`);
        
        const index = pinecone.index('simplifyir');
        
        // Generate embedding for the question
        const queryEmbedding = await generateEmbedding(question);
        
        // Search for relevant documents
        const searchResults = await index.query({
            vector: queryEmbedding,
            topK: 5,
            filter: { 
                company: { $eq: company } 
            },
            includeMetadata: true
        });
        
        console.log(`📄 Found ${searchResults.matches.length} documents for ${company}:\n`);
        
        searchResults.matches.forEach((match, i) => {
            console.log(`--- Document ${i + 1} ---`);
            console.log(`ID: ${match.id}`);
            console.log(`Score: ${match.score}`);
            console.log(`Source: ${match.metadata.source}`);
            console.log(`Document Type: ${match.metadata.document_type}`);
            console.log(`Content Length: ${match.metadata.content.length} characters`);
            console.log(`Content Preview (first 500 chars):`);
            console.log(match.metadata.content.substring(0, 500));
            console.log(`\nContent Sample (looking for revenue):`);
            
            // Look for revenue-related content
            const content = match.metadata.content.toLowerCase();
            const lines = match.metadata.content.split('\n');
            const revenueLines = lines.filter(line => 
                line.toLowerCase().includes('revenue') || 
                line.toLowerCase().includes('sales') ||
                line.toLowerCase().includes('income')
            );
            
            if (revenueLines.length > 0) {
                console.log('📊 Revenue-related lines found:');
                revenueLines.slice(0, 5).forEach(line => {
                    console.log(`  • ${line.trim()}`);
                });
            } else {
                console.log('❌ No revenue-related content found in this chunk');
            }
            
            console.log('\n' + '='.repeat(80) + '\n');
        });
        
        // Also test what context would be sent to AI
        const context = searchResults.matches.map(match => 
            `Source: ${match.metadata.source}\nContent: ${match.metadata.content}\n`
        ).join('\n---\n');
        
        console.log(`📝 Total context that would be sent to AI: ${context.length} characters`);
        console.log(`\n🧠 Context preview (first 1000 chars):`);
        console.log(context.substring(0, 1000));
        console.log('...\n');
        
    } catch (error) {
        console.error('❌ Error in debug search:', error);
    }
}

// Command line interface
async function main() {
    const args = process.argv.slice(2);
    
    if (args.length < 2) {
        console.log(`
Usage:
  node debug-search.js "QUESTION" COMPANY

Example:
  node debug-search.js "What was Apple's latest revenue?" AAPL
        `);
        return;
    }
    
    const question = args[0];
    const company = args[1];
    
    await debugSearch(question, company);
}

if (require.main === module) {
    main();
}