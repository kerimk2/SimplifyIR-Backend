require('dotenv').config();
const { Pinecone } = require('@pinecone-database/pinecone');

console.log('Testing Pinecone serverless connection with environment...');
console.log('API Key exists:', !!process.env.PINECONE_API_KEY);
console.log('Environment:', process.env.PINECONE_ENVIRONMENT);

const pinecone = new Pinecone({
  apiKey: process.env.PINECONE_API_KEY,
  environment: process.env.PINECONE_ENVIRONMENT,
});

async function testConnection() {
  try {
    console.log('Listing indexes...');
    const indexes = await pinecone.listIndexes();
    console.log('✅ Connection successful!');
    console.log('Available indexes:', indexes);
    
  } catch (error) {
    console.error('❌ Connection failed:', error.message);
    console.error('Error type:', error.constructor.name);
    
    // Try with explicit host configuration
    console.log('\nTrying with explicit host configuration...');
    try {
      const index = pinecone.Index('simplifyir', 'https://simplifyir-4ckub9f.svc.aped-4627-b74a.pinecone.io');
      const stats = await index.describeIndexStats();
      console.log('✅ Direct host connection successful!');
      console.log('Index stats:', stats);
    } catch (hostError) {
      console.error('❌ Direct host also failed:', hostError.message);
    }
  }
}

testConnection();