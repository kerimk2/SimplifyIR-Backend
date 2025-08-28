# Competitive Analysis Setup Guide

## Step 1: Get Financial Modeling Prep API Key

1. **Sign up for FMP API:**
   - Go to: https://financialmodelingprep.com/developer/docs
   - Click "Get API Key" 
   - Sign up for free account
   - Copy your API key

2. **Add to Environment Variables:**
   - Open your `.env` file
   - Add this line:
   ```
   FMP_API_KEY=your_api_key_here
   ```

## Step 2: Test the API

Once you add the API key and restart the server, you can test:

### API Endpoints Available:

**1. Comprehensive Competitive Analysis:**
```
GET /api/comp-analysis/CRWV
```
- Returns full competitive analysis comparing CoreWeave to all competitors
- Includes valuation metrics, growth rates, market positioning

**2. Individual Stock Quotes:**
```
GET /api/stock-quote/CRWV
GET /api/stock-quote/NVDA
```
- Returns current stock price, P/E ratio, market cap, etc.

**3. Query Parameters:**
```
GET /api/comp-analysis/CRWV?metric=valuation
GET /api/comp-analysis/CRWV?metric=growth
```

### Competitor Universe for CoreWeave:

**Direct Competitors:**
- DOCN (DigitalOcean)
- NET (Cloudflare)

**Cloud Infrastructure:**
- AMZN (Amazon/AWS)
- GOOGL (Google Cloud)
- MSFT (Microsoft/Azure)

**AI/GPU:**
- NVDA (NVIDIA)
- AMD (AMD)

## Step 3: Integration with Chat

The system will automatically integrate competitive analysis into chat responses when users ask questions like:

- "How does our P/E ratio compare to competitors?"
- "What's our valuation vs. cloud infrastructure companies?"
- "Show me CoreWeave's market cap compared to peers"

## API Rate Limits

**Free Tier:** 250 calls/day
- Caching is implemented (1-hour cache)
- Should be sufficient for demo purposes
- Can upgrade if needed for production

## Next Steps

After adding the API key:
1. Restart the server
2. Test the endpoints above
3. Try asking competitive questions in the chat interfaces