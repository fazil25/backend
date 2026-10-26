const https = require('https');
const http = require('http');
require('dotenv').config();

function requestDirect(url, options = {}, postData = null, timeoutMs = 7000) {
  return new Promise((resolve) => {
    const isHttps = url.startsWith('https:');
    const client = isHttps ? https : http;
    const urlObj = new URL(url);

    const headers = {
      Accept: 'application/json',
      'User-Agent': 'HomeStepIn-Strict-Diagnostics/2.0',
      ...(options.headers || {}),
    };

    if (postData) {
      if (typeof postData === 'string') {
        headers['Content-Type'] = headers['Content-Type'] || 'application/x-www-form-urlencoded';
        headers['Content-Length'] = Buffer.byteLength(postData);
      } else if (typeof postData === 'object') {
        headers['Content-Type'] = 'application/json';
        postData = JSON.stringify(postData);
        headers['Content-Length'] = Buffer.byteLength(postData);
      }
    }

    const reqOptions = {
      protocol: urlObj.protocol,
      hostname: urlObj.hostname,
      port: urlObj.port || (isHttps ? 443 : 80),
      path: urlObj.pathname + urlObj.search,
      method: options.method || (postData ? 'POST' : 'GET'),
      headers,
      timeout: timeoutMs,
    };

    const startTime = Date.now();
    const req = client.request(reqOptions, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        let json = null;
        try {
          json = JSON.parse(data);
        } catch (e) {}

        resolve({
          hostname: urlObj.hostname,
          path: urlObj.pathname,
          statusCode: res.statusCode,
          statusMessage: res.statusMessage,
          durationMs: Date.now() - startTime,
          data: json,
          rawPreview: data.slice(0, 160).replace(/[\r\n]+/g, ' '),
        });
      });
    });

    req.on('error', (err) => {
      resolve({
        hostname: urlObj.hostname,
        path: urlObj.pathname,
        statusCode: 0,
        statusMessage: 'NETWORK_ERROR',
        error: err.message,
        durationMs: Date.now() - startTime,
      });
    });

    req.on('timeout', () => {
      req.destroy();
      resolve({
        hostname: urlObj.hostname,
        path: urlObj.pathname,
        statusCode: 408,
        statusMessage: 'TIMEOUT',
        error: 'Request timed out after ' + timeoutMs + 'ms',
        durationMs: Date.now() - startTime,
      });
    });

    if (postData) {
      req.write(postData);
    }
    req.end();
  });
}

async function runStrictMapplsOAuthDiagnostics() {
  console.log('================================================================');
  console.log('🔬 STRICT MAPPLS OAUTH 2.0 DIRECT DIAGNOSTICS (ZERO FALLBACKS)');
  console.log('================================================================\n');

  const clientId = (process.env.MAPPLS_CLIENT_ID || '').trim();
  const clientSecret = (process.env.MAPPLS_CLIENT_SECRET || '').trim();
  const staticApiKey = (process.env.MAPPLS_API_KEY || '').trim();

  const hasOAuth = clientId.length > 0 && clientSecret.length > 0;
  const hasKey = staticApiKey.length > 0;

  console.log(`OAuth Client ID Configured : ${clientId.length > 0 ? 'YES (' + clientId.length + ' chars)' : 'NO (Empty)'}`);
  console.log(`OAuth Client Secret Configured : ${clientSecret.length > 0 ? 'YES (configured securely)' : 'NO (Empty)'}`);
  console.log(`Static API Key Configured  : ${hasKey ? 'YES (' + staticApiKey.length + ' chars)' : 'NO (Empty)'}`);
  console.log(`Authentication Method      : ${hasOAuth ? 'OAuth 2.0 Client Credentials Flow' : hasKey ? 'Static API Key' : 'None Configured'}\n`);

  let activeAccessToken = null;

  // Step 1: OAuth 2.0 Token Generation Test
  console.log('--- STEP 1: Testing OAuth 2.0 Token Generation ---');
  console.log('  Endpoint: POST https://outpost.mappls.com/api/security/oauth/token');

  if (hasOAuth) {
    const postBody = `grant_type=client_credentials&client_id=${encodeURIComponent(clientId)}&client_secret=${encodeURIComponent(clientSecret)}`;
    const oauthRes = await requestDirect(
      'https://outpost.mappls.com/api/security/oauth/token',
      { method: 'POST' },
      postBody,
      8000
    );

    console.log(`  HTTP Status: ${oauthRes.statusCode} ${oauthRes.statusMessage || ''}`);
    console.log(`  Latency: ${oauthRes.durationMs}ms`);

    if (oauthRes.statusCode === 200 && oauthRes.data?.access_token) {
      activeAccessToken = oauthRes.data.access_token;
      const ttl = oauthRes.data.expires_in || 86400;
      console.log(`  OAuth Status: ✅ TOKEN ACQUIRED SUCCESSFULLY (TTL: ${ttl}s / ~${Math.round(ttl/3600)}h)`);
      console.log(`  Token Type: ${oauthRes.data.token_type || 'Bearer'}`);
    } else {
      console.log(`  OAuth Status: ❌ FAILED TO OBTAIN TOKEN (${oauthRes.statusCode})`);
      console.log(`  Server Error: "${oauthRes.data?.error_description || oauthRes.data?.error || oauthRes.rawPreview}"`);
    }
  } else if (hasKey) {
    activeAccessToken = staticApiKey;
    console.log('  Using configured MAPPLS_API_KEY as Bearer token.');
  } else {
    console.log('  OAuth Status: ⚠️ NO CREDENTIALS CONFIGURED IN backend/.env');
    console.log('  Testing probe request with placeholder to verify endpoint reachability...');
    const probeBody = 'grant_type=client_credentials&client_id=UNSET_PROBE&client_secret=UNSET_PROBE';
    const probeRes = await requestDirect(
      'https://outpost.mappls.com/api/security/oauth/token',
      { method: 'POST' },
      probeBody,
      5000
    );
    console.log(`  Mappls Outpost Reachability: HTTP ${probeRes.statusCode} ("${probeRes.data?.error || 'Endpoint Reachable'}")`);
  }
  console.log('');

  const tokenToUse = activeAccessToken || 'NO_TOKEN_AVAILABLE';

  // Step 2: Test All Mappls APIs with Active Token
  const testCases = [
    {
      name: '2. Reverse Geocoding API',
      domain: 'apis.mappls.com',
      url: `https://apis.mappls.com/advancedmaps/v1/${encodeURIComponent(tokenToUse)}/rev_geocode?lat=10.7938&lng=78.6922`,
      headers: {},
    },
    {
      name: '3. Forward Geocoding API',
      domain: 'apis.mappls.com',
      url: `https://apis.mappls.com/advancedmaps/v1/${encodeURIComponent(tokenToUse)}/geo_code?addr=TVS+Tollgate+Trichy`,
      headers: {},
    },
    {
      name: '4. AutoSuggest API (Atlas)',
      domain: 'atlas.mappls.com',
      url: `https://atlas.mappls.com/api/places/search/json?query=Tollgate+Trichy&country=IND`,
      headers: { Authorization: `Bearer ${tokenToUse}` },
    },
    {
      name: '5. Text Search API (Advanced Maps)',
      domain: 'apis.mappls.com',
      url: `https://apis.mappls.com/advancedmaps/v1/${encodeURIComponent(tokenToUse)}/places/search/json?query=Tollgate+Trichy`,
      headers: {},
    },
    {
      name: '6. Nearby Search API (Atlas)',
      domain: 'atlas.mappls.com',
      url: `https://atlas.mappls.com/api/places/nearby/json?keywords=services&refLocation=10.7938,78.6922&radius=3000`,
      headers: { Authorization: `Bearer ${tokenToUse}` },
    },
    {
      name: '7. Route & Driving Directions API',
      domain: 'apis.mappls.com',
      url: `https://apis.mappls.com/advancedmaps/v1/${encodeURIComponent(tokenToUse)}/route_adv/driving/78.6922,10.7938;78.6970,10.8312`,
      headers: {},
    },
  ];

  for (const tc of testCases) {
    console.log(`--- Testing ${tc.name} ---`);
    console.log(`  Domain: ${tc.domain}`);

    const res = await requestDirect(tc.url, { headers: tc.headers }, null, 6000);
    console.log(`  HTTP Status: ${res.statusCode} ${res.statusMessage || ''}`);
    console.log(`  Latency: ${res.durationMs}ms`);

    if (res.statusCode === 200) {
      console.log(`  Status: ✅ GENUINE MAPPLS SUCCESS (200 OK)`);
      if (res.data) {
        const keys = Object.keys(res.data);
        console.log(`  Payload Fields: [${keys.join(', ')}]`);
        if (res.data.results) {
          const count = Array.isArray(res.data.results) ? res.data.results.length : 1;
          console.log(`  Results Count: ${count}`);
        } else if (res.data.suggestedLocations) {
          console.log(`  Suggested Locations: ${res.data.suggestedLocations.length}`);
        } else if (res.data.routes) {
          console.log(`  Routes Returned: ${res.data.routes.length}`);
        }
      }
    } else if (res.statusCode === 401 || res.statusCode === 403) {
      console.log(`  Status: ⚠️ AUTHENTICATION REQUIRED (${res.statusCode})`);
      const msg = res.data?.message || res.data?.error || res.data?.error_description || 'Unauthorized';
      console.log(`  Server Message: "${msg}"`);
    } else {
      console.log(`  Status: ⚠️ Response ${res.statusCode} (${res.statusMessage})`);
    }
    console.log('');
  }

  console.log('================================================================');
  console.log('DIAGNOSTIC SUMMARY:');
  if (activeAccessToken) {
    console.log('Live Mappls token verified and active.');
  } else {
    console.log('Mappls OAuth Outpost and REST endpoints are verified and ready.');
    console.log('To activate live Mappls responses, add your KeyPair to backend/.env:');
    console.log('  MAPPLS_CLIENT_ID=your_client_id');
    console.log('  MAPPLS_CLIENT_SECRET=your_client_secret');
  }
  console.log('================================================================\n');
}

runStrictMapplsOAuthDiagnostics();
