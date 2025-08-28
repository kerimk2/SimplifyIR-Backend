require('dotenv').config();

class PineconeREST {
  constructor() {
    this.apiKey = process.env.PINECONE_API_KEY;
    this.indexHost = 'https://simplifyir-4ckub9f.svc.aped-4627-b74a.pinecone.io';
  }

  async describeIndexStats() {
    const response = await fetch(`${this.indexHost}/describe_index_stats`, {
      method: 'POST',
      headers: {
        'Api-Key': this.apiKey,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({})
    });

    if (!response.ok) {
      throw new Error(`Pinecone API error: ${response.status}`);
    }

    return await response.json();
  }

  async query(vector, topK = 6, filter = {}) {
    const response = await fetch(`${this.indexHost}/query`, {
      method: 'POST',
      headers: {
        'Api-Key': this.apiKey,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        vector: vector,
        topK: topK,
        filter: filter,
        includeMetadata: true
      })
    });

    if (!response.ok) {
      throw new Error(`Pinecone query error: ${response.status}`);
    }

    return await response.json();
  }

  async upsert(vectors) {
    const response = await fetch(`${this.indexHost}/vectors/upsert`, {
      method: 'POST',
      headers: {
        'Api-Key': this.apiKey,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        vectors: vectors
      })
    });

    if (!response.ok) {
      throw new Error(`Pinecone upsert error: ${response.status}`);
    }

    return await response.json();
  }
}

module.exports = PineconeREST;
