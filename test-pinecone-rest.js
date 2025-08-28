require('dotenv').config();

async function testPineconeRest() {
  try {
    console.log('Testing Pinecone REST API...');
    
    const response = await fetch('https://api.pinecone.io/indexes', {
      method: 'GET',
      headers: {
        'Api-Key': process.env.PINECONE_API_KEY,
        'Content-Type': 'application/json'
      }
    });
    
    if (response.ok) {
      const data = await response.json();
      console.log('✅ REST API connection successful!');
      console.log('Indexes:', data);
    } else {
      console.error('❌ REST API failed:', response.status, response.statusText);
      console.error('Response:', await response.text());
    }
    
  } catch (error) {
    console.error('❌ REST API error:', error.message);
  }
}

testPineconeRest();
