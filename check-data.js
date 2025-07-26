const { Pinecone } = require('@pinecone-database/pinecone');
const OpenAI = require('openai');
const dotenv = require('dotenv');

dotenv.config();

const pinecone = new Pinecone({
    apiKey: process.env.PINECONE_API_KEY
});

const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY
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

async function checkDatabaseContents() {
    try {
        console.log('🔍 Checking database contents...');
        
        const index = pinecone.index('simplifyir');
        
        // Get index stats
        const stats = await index.describeIndexStats();
        console.log('📊 Index stats:', JSON.stringify(stats, null, 2));
        
        // Try a simple query to see what's there
        const queryResults = await index.query({
            vector: new Array(1536).fill(0.1), // dummy vector
            topK: 5,
            includeMetadata: true
        });
        
        console.log('\n📄 Sample documents in database:');
        queryResults.matches.forEach((match, i) => {
            console.log(`${i + 1}. ID: ${match.id}`);
            console.log(`   Company: ${match.metadata.company}`);
            console.log(`   Source: ${match.metadata.source}`);
            console.log(`   Content preview: ${match.metadata.content.substring(0, 100)}...`);
            console.log('');
        });
        
    } catch (error) {
        console.error('❌ Error checking database:', error);
    }
}

async function testSearch() {
    try {
        console.log('\n🔍 Testing search for DEMO...');
        
        const index = pinecone.index('simplifyir');
        
        // Test 1: Simple search with filter
        console.log('Test 1: Filter-only search');
        const filterResults = await index.query({
            vector: new Array(1536).fill(0.1), // dummy vector
            topK: 5,
            filter: { 
                company: { $eq: "DEMO" } 
            },
            includeMetadata: true
        });
        
        console.log(`Found ${filterResults.matches.length} DEMO documents with filter`);
        
        // Test 2: Real embedding search
        console.log('\nTest 2: Real embedding search');
        const queryEmbedding = await generateEmbedding("What was DEMO company's revenue in Q3?");
        
        const embeddingResults = await index.query({
            vector: queryEmbedding,
            topK: 5,
            filter: { 
                company: { $eq: "DEMO" } 
            },
            includeMetadata: true
        });
        
        console.log(`Found ${embeddingResults.matches.length} DEMO documents with embedding search`);
        embeddingResults.matches.forEach((match, i) => {
            console.log(`${i + 1}. Score: ${match.score}, Source: ${match.metadata.source}`);
            console.log(`   Content: ${match.metadata.content.substring(0, 200)}...`);
        });
        
        // Test 3: Search without filter
        console.log('\nTest 3: Search without company filter');
        const noFilterResults = await index.query({
            vector: queryEmbedding,
            topK: 5,
            includeMetadata: true
        });
        
        console.log(`Found ${noFilterResults.matches.length} documents without filter`);
        noFilterResults.matches.forEach((match, i) => {
            console.log(`${i + 1}. Company: ${match.metadata.company}, Score: ${match.score}`);
        });
        
    } catch (error) {
        console.error('❌ Error in test search:', error);
    }
}

async function runAllTests() {
    await checkDatabaseContents();
    await testSearch();
}

runAllTests();
