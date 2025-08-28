require('dotenv').config();
const { PineconeClient } = require('@pinecone-database/pinecone');

async function testConnection() {
  try {
    console.log('Testing with older Pinecone SDK v0.1.6...');
    
    const pinecone = new PineconeClient();
    await pinecone.init({
      environment: process.env.PINECONE_ENVIRONMENT,
      apiKey: process.env.PINECONE_API_KEY,
    });
    
    console.log('✅ Pinecone client initialized!');
    
    const index = pinecone.Index('simplifyir');
    const stats = await index.describeIndexStats();
    console.log('✅ Index connection successful!');
    console.log('Stats:', stats);
    
  } catch (error) {
    console.error('❌ Error:', error.message);
  }
}

testConnection();
