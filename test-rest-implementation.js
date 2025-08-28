const PineconeREST = require('./pinecone-rest');

async function testRestImplementation() {
  try {
    console.log('Testing REST API implementation...');
    
    const pinecone = new PineconeREST();
    
    // Test connection
    const stats = await pinecone.describeIndexStats();
    console.log('✅ REST API connection successful!');
    console.log('Index stats:', stats);
    
  } catch (error) {
    console.error('❌ Error:', error.message);
  }
}

testRestImplementation();
