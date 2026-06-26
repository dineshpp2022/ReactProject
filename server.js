import express from 'express';
import httpProxy from 'http-proxy';
import { CookieJar } from 'tough-cookie';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

// Load environment variables from .env file
import dotenv from 'dotenv';
dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Allowed origins for CORS - configurable via environment variables
// Format: comma-separated list or use NODE_ENV to auto-detect
const getAllowedOrigins = () => {
  const env = process.env.NODE_ENV || 'development';
  
  // Custom origins from environment variable (takes priority)
  if (process.env.ALLOWED_ORIGINS) {
    return process.env.ALLOWED_ORIGINS.split(',').map(origin => origin.trim());
  }
  
  // Default origins based on environment
  if (env === 'production') {
    return [
      'http://localhost:5174', // Local testing
      'http://192.168.1.1', // IIS server
      'http://192.168.1.1/odoo', // IIS app subdirectory
      'https://192.168.1.1', // HTTPS version
      'https://192.168.1.1/odoo',
      // Add your actual domain here when available:
      // 'http://yourdomain.com',
      // 'http://yourdomain.com/odoo',
    ];
  }
  
  // Development/local
  return [
    'http://localhost:5175',
    'http://localhost:5174',
    'http://127.0.0.1:5175',
    'http://127.0.0.1:5174',
  ];
};

const ALLOWED_ORIGINS = getAllowedOrigins();

console.log(`Starting server in ${process.env.NODE_ENV || 'development'} mode`);
console.log(`Allowed origins:`, ALLOWED_ORIGINS);

const app = express();

// ── Transparent reverse proxy: open the NATIVE Odoo web client with no re-login ──
// When the browser hits an instance subdomain (e.g. squadsm.<PROXY_DOMAIN>), every
// path is forwarded straight to that Odoo instance with the server-side session
// (from the cookie jar captured at app login) injected. Paths are PRESERVED — not
// moved under a sub-path — so the Odoo 19 OWL client's root-absolute /web/* URLs,
// lazy assets and bus resolve correctly and the client mounts already authenticated.
// (The old /odoo-proxy/<id>/* sub-path rewriter could not do this -> blank page.)
// This middleware MUST run before express.json() so bodies stream to Odoo untouched.
// No ws:true — we handle WebSocket upgrades manually with per-connection proxies
// to prevent one instance's WS failure (e.g. on-premise without WS configured)
// from corrupting the shared proxy state and taking down other instances.
const proxy = httpProxy.createProxyServer({ changeOrigin: true, secure: true });

proxy.on('error', (err, req, res) => {
  console.error('[transparent-proxy] error:', err.message);
  if (!res) return;
  if (typeof res.writeHead === 'function' && !res.headersSent) {
    res.writeHead(502);
    res.end('Odoo proxy error: ' + err.message);
  } else if (typeof res.destroy === 'function') {
    // WebSocket error: res is actually the socket — destroy it cleanly
    res.destroy();
  }
});

// Add hook to log proxy requests before they're sent
proxy.on('proxyReq', (proxyReq, req, res) => {
  // Ensure cookies are properly forwarded
  if (req.headers.cookie && req._odooTarget) {
    proxyReq.setHeader('Cookie', req.headers.cookie);
    console.log(`[proxy-request] ✓ SET Cookie header: ${req.headers.cookie.substring(0, 60)}...`);
  } else if (req._odooTarget) {
    console.log(`[proxy-request] ⚠ NO Cookie header for ${req._odooTarget}`);
    // Remove any default cookies that might be set
    proxyReq.removeHeader('Cookie');
  }
});

// Persist any rotated Odoo session cookie back into the jar so the session stays alive.
proxy.on('proxyRes', (proxyRes, req) => {
  const setCookies = proxyRes.headers['set-cookie'];
  if (setCookies && req._odooJar && req._odooTarget) {
    console.log(`[proxy-response] Updating cookies from proxyRes for ${req._odooTarget}`);
    for (const c of setCookies) {
      req._odooJar.setCookie(c, req._odooTarget).catch((err) => {
        console.warn(`[proxy-response] Failed to update cookie: ${err.message}`);
      });
    }
  }
});

app.use(async (req, res, next) => {
  const instanceId = resolveInstanceIdFromHost(req.headers.host);
  if (!instanceId) return next(); // app/API host -> fall through to normal routing below

  const inst = getInstance(instanceId);
  if (!inst) return res.status(404).send('Odoo instance not found or has been deleted');

  // Inject the server-held session for this instance (browser carries no Odoo cookie).
  try {
    // Strip fragment from URL (tough-cookie doesn't handle #hashes well)
    const urlWithoutFragment = req.url.split('#')[0] || '/';
    const cookieUrl = inst.target + urlWithoutFragment;
    
    console.log(`[transparent-proxy] Requesting cookies for: ${cookieUrl}`);
    console.log(`[transparent-proxy] Cookie jar contents: ${inst.jar.cookieCount ? inst.jar.cookieCount() + ' cookies' : 'empty'}`);
    
    const cookie = await inst.jar.getCookieString(cookieUrl);
    
    if (cookie && cookie.trim()) {
      req.headers.cookie = cookie;
      console.log(`[transparent-proxy] ✓ INJECTED for ${instanceId}: ${cookie.substring(0, 50)}...`);
    } else {
      console.warn(`[transparent-proxy] ✗ NO SESSION for ${instanceId}. Jar empty or cookies don't match path.`);
      console.warn(`[transparent-proxy]   Instance target: ${inst.target}`);
      console.warn(`[transparent-proxy]   Request URL: ${req.url}`);
      console.warn(`[transparent-proxy]   Cookie lookup URL: ${cookieUrl}`);
      delete req.headers.cookie;
    }
  } catch (e) {
    console.error(`[transparent-proxy] ✗ ERROR for ${instanceId}: ${e.message}`);
    console.error(`[transparent-proxy]   Stack:`, e.stack);
    delete req.headers.cookie;
  }

  req._odooTarget = inst.target;
  req._odooJar = inst.jar;
  proxy.web(req, res, { target: inst.target, cookieDomainRewrite: '', autoRewrite: true });
});

app.use(express.json());

// Serve static files from the Vite build output
const distPath = path.join(__dirname, 'dist');
if (fs.existsSync(distPath)) {
  app.use(express.static(distPath));
}

app.use((req, res, next) => {
  // CORS configuration
  const origin = req.headers.origin;
  
  // Check if origin is allowed
  if (origin && ALLOWED_ORIGINS.includes(origin)) {
    res.header('Access-Control-Allow-Origin', origin);
    res.header('Access-Control-Allow-Credentials', 'true');
  } else if (!origin) {
    // Allow same-origin requests
    res.header('Access-Control-Allow-Origin', '*');
  }
  
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  
  if (req.method === 'OPTIONS') {
    return res.sendStatus(200);
  }
  next();
});

const CONNECTIONS_FILE = path.join(__dirname, 'connections.json');
const SESSIONS_FILE = path.join(__dirname, 'sessions.json');
const INSTANCE_JARS = new Map(); // Map to store CookieJars for dynamic instances

// Initialize with default instances for backward compatibility
const INSTANCES = {
  squadsm: { target: 'https://squadsm.odoo.com', jar: new CookieJar() },
  squadts: { target: 'https://squadts.odoo.com', jar: new CookieJar() },
  'squad-atlas': { target: 'https://squad-atlas.odoo.com', jar: new CookieJar() },
};

// Session persistence helpers
const persistSessionCookies = async () => {
  try {
    const sessions = {};
    
    // Get cookies from all instances
    for (const [id, inst] of Object.entries(INSTANCES)) {
      try {
        const cookies = await inst.jar.getCookieString(inst.target);
        if (cookies) {
          sessions[id] = { target: inst.target, cookies, timestamp: Date.now() };
        }
      } catch (e) {
        console.warn(`[persistSessionCookies] Could not persist cookies for ${id}:`, e.message);
      }
    }
    
    // Also persist dynamic instances
    for (const [id, jar] of INSTANCE_JARS) {
      const data = loadConnections();
      const conn = (data.connections || []).find(c => c.id === id);
      if (conn) {
        try {
          const cookies = await jar.getCookieString(conn.url);
          if (cookies) {
            sessions[id] = { target: conn.url, cookies, timestamp: Date.now() };
          }
        } catch (e) {
          console.warn(`[persistSessionCookies] Could not persist cookies for dynamic ${id}:`, e.message);
        }
      }
    }
    
    if (Object.keys(sessions).length > 0) {
      fs.writeFileSync(SESSIONS_FILE, JSON.stringify(sessions, null, 2));
      console.log(`[persistSessionCookies] Saved ${Object.keys(sessions).length} session(s) to disk`);
    }
  } catch (error) {
    console.error('[persistSessionCookies] Error:', error.message);
  }
};

const restoreSessionCookies = async () => {
  try {
    if (!fs.existsSync(SESSIONS_FILE)) return;
    
    const sessions = JSON.parse(fs.readFileSync(SESSIONS_FILE, 'utf-8'));
    let restored = 0;
    
    for (const [id, session] of Object.entries(sessions)) {
      // Check if session is not too old (24 hours)
      const ageHours = (Date.now() - session.timestamp) / (1000 * 60 * 60);
      if (ageHours > 24) {
        console.log(`[restoreSessionCookies] Skipping expired session for ${id} (${ageHours.toFixed(1)} hours old)`);
        continue;
      }
      
      try {
        // Restore to default instances
        if (INSTANCES[id]) {
          await INSTANCES[id].jar.setCookie(session.cookies, session.target);
          restored++;
          console.log(`[restoreSessionCookies] ✓ Restored session for ${id}`);
        } else {
          // Try to restore to dynamic instance
          const jar = getInstanceJar(id);
          await jar.setCookie(session.cookies, session.target);
          restored++;
          console.log(`[restoreSessionCookies] ✓ Restored dynamic session for ${id}`);
        }
      } catch (e) {
        console.warn(`[restoreSessionCookies] Failed to restore session for ${id}:`, e.message);
      }
    }
    
    if (restored > 0) {
      console.log(`[restoreSessionCookies] Successfully restored ${restored}/${Object.keys(sessions).length} session(s)`);
    }
  } catch (error) {
    console.error('[restoreSessionCookies] Error:', error.message);
  }
};

// Load connections from file
const loadConnections = () => {
  try {
    if (fs.existsSync(CONNECTIONS_FILE)) {
      const data = fs.readFileSync(CONNECTIONS_FILE, 'utf-8');
      return JSON.parse(data);
    }
  } catch (error) {
    console.error('Error loading connections:', error);
  }
  return { connections: [], deletedInstances: [] };
};

// Save connections to file
const saveConnections = (data) => {
  try {
    console.log('[saveConnections] Writing to file:', CONNECTIONS_FILE);
    fs.writeFileSync(CONNECTIONS_FILE, JSON.stringify(data, null, 2));
    console.log('[saveConnections] Successfully saved');
  } catch (error) {
    console.error('[saveConnections] Failed to save:', error.message, 'at', CONNECTIONS_FILE);
    throw error;
  }
};

// Get or create CookieJar for an instance
const getInstanceJar = (instanceId) => {
  if (!INSTANCE_JARS.has(instanceId)) {
    INSTANCE_JARS.set(instanceId, new CookieJar());
  }
  return INSTANCE_JARS.get(instanceId);
};

const getInstance = (instanceId) => {
  const data = loadConnections();
  const deletedIds = data.deletedInstances || [];
  
  // Check if instance is deleted
  if (deletedIds.includes(instanceId)) {
    return null;
  }
  
  // Check dynamic instances
  const connection = (data.connections || []).find(c => c.id === instanceId);
  if (connection) {
    return { 
      target: connection.url, 
      jar: getInstanceJar(instanceId)
    };
  }
  
  // Fall back to default instances only if not deleted
  return INSTANCES[instanceId] || null;
};

// Map an incoming proxy host to a known instance id, matching the first DNS label
// against a connection id or dbName (and tolerating a "-proxy" suffix). Returns null
// for the app/API host (bare "localhost", the SPA origin, etc.) so normal routing runs.
const resolveInstanceIdFromHost = (host) => {
  if (!host) return null;
  const hostname = host.split(':')[0];
  const parts = hostname.split('.');
  if (parts.length < 2) return null; // bare host (e.g. "localhost") = app/API, not a proxy
  const sub = parts[0].replace(/-proxy$/, '');
  if (!sub || sub === 'www' || sub === 'localhost') return null;

  const data = loadConnections();
  const deleted = data.deletedInstances || [];
  const match = (data.connections || []).find(
    c => (c.id === sub || c.dbName === sub) && !deleted.includes(c.id)
  );
  if (match) return match.id;
  if (INSTANCES[sub] && !deleted.includes(sub)) return sub;
  return null;
};

// Connection Management Endpoints
app.get('/api/connections', (req, res) => {
  try {
    const data = loadConnections();
    const deletedIds = data.deletedInstances || [];
    
    // Get custom connections and filter out deleted ones
    const customConnections = (data.connections || []).filter(c => !deletedIds.includes(c.id));
    
    // Add default instances that haven't been deleted
    const defaultConnections = [
      { id: 'squadsm', label: 'SquadSM', url: 'https://squadsm.odoo.com', dbName: 'squadsm', availableModules: ['contacts', 'helpdesk', 'tasks'] },
      { id: 'squadts', label: 'SquadTS', url: 'https://squadts.odoo.com', dbName: 'squadts', availableModules: ['contacts', 'helpdesk', 'tasks'] },
      { id: 'squad-atlas', label: 'Squad Atlas', url: 'https://squad-atlas.odoo.com', dbName: 'squad-atlas', availableModules: ['contacts', 'helpdesk', 'tasks'] }
    ].filter(c => !deletedIds.includes(c.id));
    
    const allConnections = [...defaultConnections, ...customConnections];
    console.log('[GET /api/connections] Returning:', JSON.stringify(allConnections).substring(0, 200));
    res.json(allConnections);
  } catch (error) {
    console.error('[GET /api/connections] Error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Session status endpoint - check if a session is valid for an instance
app.get('/api/session/status/:connectionId', async (req, res) => {
  try {
    const { connectionId } = req.params;
    const inst = getInstance(connectionId);
    
    if (!inst) {
      return res.status(404).json({ status: 'not-found', message: 'Instance not found' });
    }
    
    try {
      // Get all cookies in the jar
      const allCookies = await inst.jar.getCookies(inst.target);
      console.log(`[session/status] ${connectionId} has ${allCookies.length} cookie(s) in jar`);
      allCookies.forEach((c, i) => {
        console.log(`[session/status]   ${i+1}. ${c.key}=${c.value.substring(0, 30)}... (path="${c.path}", domain="${c.domain}")`);
      });
      
      const cookies = await inst.jar.getCookieString(inst.target);
      console.log(`[session/status] getCookieString(${inst.target}) returned: ${cookies ? cookies.substring(0, 50) + '...' : 'empty'}`);
      
      if (!cookies || cookies.trim() === '') {
        return res.json({ 
          status: 'no-session', 
          message: 'No session cookies stored for this instance',
          instance: connectionId,
          jarContents: allCookies.map(c => ({ key: c.key, domain: c.domain, path: c.path }))
        });
      }
      
      // Verify session is still valid by making a test call
      const testResp = await fetch(`${inst.target}/web/session/get_session_info`, {
        method: 'GET',
        headers: { 'Cookie': cookies }
      });
      
      if (testResp.ok) {
        const sessionInfo = await testResp.json();
        return res.json({
          status: 'active',
          message: 'Session is valid',
          instance: connectionId,
          user_id: sessionInfo.result?.uid,
          username: sessionInfo.result?.name
        });
      } else {
        return res.json({
          status: 'expired',
          message: `Session validation failed (HTTP ${testResp.status})`,
          instance: connectionId
        });
      }
    } catch (e) {
      return res.json({
        status: 'error',
        message: `Error checking session: ${e.message}`,
        instance: connectionId
      });
    }
  } catch (error) {
    console.error('[GET /api/session/status] Error:', error);
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/connections', (req, res) => {
  try {
    console.log('[POST /api/connections] Request body:', JSON.stringify(req.body).substring(0, 200));
    const { url, label, dbName } = req.body;
    
    // Validate URL contains odoo.com
    if (!url) {
      console.log('[POST /api/connections] Validation error: URL is required');
      return res.status(400).json({ error: 'URL is required' });
    }
    if (!url.includes('odoo.com')) {
      console.log('[POST /api/connections] Validation error: URL must contain "odoo.com"');
      return res.status(400).json({ error: 'URL must contain "odoo.com"' });
    }
    
    // Validate label
    if (!label || label.trim() === '') {
      console.log('[POST /api/connections] Validation error: Label is required');
      return res.status(400).json({ error: 'Label is required' });
    }
    
    // Validate dbName
    if (!dbName || dbName.trim() === '') {
      console.log('[POST /api/connections] Validation error: Database name is required');
      return res.status(400).json({ error: 'Database name is required' });
    }
    
    console.log('[POST /api/connections] All validations passed, loading connections...');
    const data = loadConnections();
    const connections = data.connections || [];
    const deletedInstances = data.deletedInstances || [];
    
    // Check if URL already exists in ACTIVE connections (not deleted)
    const existingConnection = connections.find(c => c.url === url && !deletedInstances.includes(c.id));
    if (existingConnection) {
      console.log('[POST /api/connections] Error: URL already exists:', url);
      return res.status(400).json({ error: 'This URL already exists' });
    }
    
    const id = `custom_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    const newConnection = {
      id,
      label: label.trim(),
      url: url.trim(),
      dbName: dbName.trim(),
      availableModules: ['contacts', 'helpdesk', 'tasks']
    };
    
    console.log('[POST /api/connections] Creating new connection:', id);
    connections.push(newConnection);
    
    console.log('[POST /api/connections] Saving connections to file...');
    saveConnections({ connections, deletedInstances });
    
    const response = {
      id,
      label: newConnection.label,
      url: newConnection.url,
      dbName: newConnection.dbName,
      availableModules: newConnection.availableModules
    };
    
    console.log('[POST /api/connections] Success, returning:', JSON.stringify(response).substring(0, 200));
    res.status(201).json(response);
  } catch (error) {
    console.error('[POST /api/connections] EXCEPTION:', error.message, '\nStack:', error.stack);
    res.status(500).json({ error: `Server error: ${error.message}` });
  }
});

app.delete('/api/connections/:id', (req, res) => {
  try {
    const { id } = req.params;
    console.log('[DELETE /api/connections/:id] Deleting:', id);
    const data = loadConnections();
    const deletedInstances = data.deletedInstances || [];
    
    // Check if it's a default instance (predefined Odoo URLs)
    const defaultInstanceIds = ['squadsm', 'squadts', 'squad-atlas'];
    
    if (defaultInstanceIds.includes(id)) {
      // For default instances, just mark as deleted
      if (!deletedInstances.includes(id)) {
        deletedInstances.push(id);
      }
      saveConnections({ 
        connections: data.connections || [], 
        deletedInstances 
      });
    } else {
      // For custom connections, actually remove from the array
      const connections = (data.connections || []).filter(c => c.id !== id);
      saveConnections({ 
        connections, 
        deletedInstances 
      });
    }
    
    // Clear cookies for deleted instance
    INSTANCE_JARS.delete(id);
    
    const response = { message: 'Connection deleted successfully' };
    console.log('[DELETE /api/connections/:id] Response:', JSON.stringify(response));
    res.json(response);
  } catch (error) {
    console.error('[DELETE /api/connections/:id] Error:', error);
    res.status(500).json({ error: error.message });
  }
});

app.put('/api/connections/:id', (req, res) => {
  try {
    const { id } = req.params;
    const { label } = req.body;
    
    const data = loadConnections();
    const connections = data.connections || [];
    const connection = connections.find(c => c.id === id);
    
    if (!connection) {
      return res.status(404).json({ error: 'Connection not found' });
    }
    
    if (label) {
      connection.label = label.trim();
    }
    
    saveConnections({ 
      connections, 
      deletedInstances: data.deletedInstances || [] 
    });
    
    res.json({
      id: connection.id,
      label: connection.label,
      url: connection.url,
      availableModules: connection.availableModules
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ── Odoo API Proxy Endpoints ──
// These endpoints proxy Odoo API calls from the browser to the actual Odoo instance,
// avoiding CORS issues by going through the server.

app.post('/api/odoo/authenticate/:connectionId', async (req, res) => {
  try {
    const { connectionId } = req.params;
    const { username, password, dbName, url } = req.body;
    
    console.log(`[authenticate] Starting for ${connectionId} as user: ${username}`);
    
    if (!connectionId || !username || !password || !dbName) {
      return res.status(400).json({ error: 'Missing required fields: connectionId, username, password, dbName' });
    }

    if (!url) {
      return res.status(400).json({ error: 'Missing Odoo URL' });
    }

    // Create or get instance for this connection
    // If it doesn't exist in connections.json, create it temporarily in memory
    let inst = getInstance(connectionId);
    
    if (!inst) {
      // Connection not found in file, create it on-the-fly from the provided URL
      console.log(`[authenticate] Creating on-the-fly connection: ${connectionId} -> ${url}`);
      const jar = getInstanceJar(connectionId);
      inst = { target: url, jar };
    }

    // Make authentication request to the Odoo instance
    const authBody = JSON.stringify({
      jsonrpc: '2.0',
      method: 'call',
      id: 0,
      params: {
        db: dbName,
        login: username,
        password: password
      }
    });

    console.log(`[authenticate] Making request to ${inst.target}/web/session/authenticate`);
    
    const authResp = await fetch(`${inst.target}/web/session/authenticate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: authBody
    });

    const authData = await authResp.json();
    
    // Store session cookies for this instance - handle multiple Set-Cookie headers
    const setCookies = authResp.headers.getSetCookie?.() || [];
    if (!setCookies.length) {
      const setCookie = authResp.headers.get('set-cookie');
      if (setCookie) setCookies.push(setCookie);
    }
    
    console.log(`[authenticate] Received ${setCookies.length} Set-Cookie header(s)`);
    
    if (setCookies.length > 0 && inst.jar) {
      for (const setCookie of setCookies) {
        try {
          await inst.jar.setCookie(setCookie, inst.target);
          console.log(`[authenticate] ✓ Stored: ${setCookie.substring(0, 60)}...`);
        } catch (e) {
          console.warn(`[authenticate] ⚠ Failed to store: ${e.message}`);
        }
      }
      
      // Immediately persist to disk for recovery
      persistSessionCookies();
    } else {
      console.warn(`[authenticate] ⚠ No Set-Cookie header(s) in auth response`);
      console.warn(`[authenticate]   Status: ${authResp.status}`);
      console.warn(`[authenticate]   Headers: ${JSON.stringify(Object.fromEntries(authResp.headers))}`);
    }

    if (authData?.error) {
      console.error(`[authenticate] ✗ Auth failed: ${authData.error.message}`);
      return res.status(401).json({ error: authData.error.message || 'Authentication failed' });
    }

    // Ensure this connection ID is in connections.json so the transparent proxy
    // can resolve <dbName>.localhost → this connectionId → correct session jar.
    // We skip only if already registered and not deleted (no jar mismatch possible).
    if (dbName && url) {
      try {
        const data = loadConnections();
        const connections = data.connections || [];
        const deletedIds = data.deletedInstances || [];
        const alreadyRegistered = connections.some(c => c.id === connectionId && !deletedIds.includes(c.id));
        if (!alreadyRegistered) {
          // Remove other non-deleted entries for the same dbName to avoid ambiguous
          // proxy lookups (only one active entry per dbName should exist).
          const deduped = connections.filter(c => c.dbName !== dbName || deletedIds.includes(c.id));
          deduped.push({ id: connectionId, label: dbName, url, dbName, availableModules: ['contacts', 'helpdesk', 'tasks'] });
          saveConnections({ connections: deduped, deletedInstances: deletedIds });
          console.log(`[authenticate] Registered ${connectionId} (${dbName}) in connections.json for proxy routing`);
        }
      } catch (e) {
        console.warn(`[authenticate] Could not register connection in connections.json: ${e.message}`);
      }
    }

    console.log(`[authenticate] ✓ Successfully authenticated ${connectionId} as ${username}`);
    res.json(authData.result);
  } catch (error) {
    console.error('[authenticate] Error:', error.message);
    res.status(500).json({ error: `Server error: ${error.message}` });
  }
});

app.post('/api/odoo/call/:connectionId', async (req, res) => {
  try {
    const { connectionId } = req.params;
    const { method, params } = req.body;

    if (!connectionId || !method || !params) {
      return res.status(400).json({ error: 'Missing required fields: connectionId, method, params' });
    }

    // Try to get existing instance, or create temp one from params if URL provided
    let inst = getInstance(connectionId);
    
    if (!inst && params._odooUrl) {
      // If connection not found but URL is provided, create temporary instance
      console.log(`[POST /api/odoo/call] Creating on-the-fly connection: ${connectionId} -> ${params._odooUrl}`);
      const jar = getInstanceJar(connectionId);
      inst = { target: params._odooUrl, jar };
    }

    if (!inst) {
      return res.status(404).json({ error: 'Connection not found' });
    }

    // Extract routing info from params
    const apiUrl = params.url || '/web/dataset/call_kw';
    
    // Clean params: remove custom fields that are for server routing only
    const cleanParams = { ...params };
    delete cleanParams._odooUrl;
    delete cleanParams.url;

    // Get stored session cookie
    let cookie = '';
    try {
      cookie = await inst.jar.getCookieString(inst.target);
    } catch (e) {
      console.warn('[api/odoo/call] No session cookie yet:', e.message);
    }

    // Make API call to Odoo with stored session (using cleaned params)
    const callBody = JSON.stringify({
      jsonrpc: '2.0',
      method: 'call',
      params: cleanParams
    });

    const callResp = await fetch(`${inst.target}${apiUrl}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(cookie && { 'Cookie': cookie })
      },
      body: callBody
    });

    const callData = await callResp.json();

    // Update session cookie if rotated
    const setCookie = callResp.headers.get('set-cookie');
    if (setCookie && inst.jar) {
      await inst.jar.setCookie(setCookie, inst.target).catch(() => {});
    }

    if (callData?.error) {
      return res.status(400).json({ error: callData.error.message || 'API call failed' });
    }

    res.json(callData.result);
  } catch (error) {
    console.error('[POST /api/odoo/call] Error:', error.message);
    res.status(500).json({ error: `Server error: ${error.message}` });
  }
});

// Proxy for Odoo web interface and all resources
app.all('/odoo-proxy/:instanceId/*', async (req, res) => {
  try {
    const { instanceId } = req.params;
    const resourcePath = req.params[0] || '';
    const instanceData = getInstance(instanceId);
    
    if (!instanceData) {
      return res.status(404).send('Instance not found or has been deleted');
    }
    
    const targetUrl = `${instanceData.target}/${resourcePath}`;
    
    // Get cookies for this instance
    const cookieHeader = await instanceData.jar.getCookieString(targetUrl);
    const headers = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    };
    if (cookieHeader) {
      headers.Cookie = cookieHeader;
    }
    
    // Copy request headers for POST/PUT
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      if (req.headers['content-type']) {
        headers['Content-Type'] = req.headers['content-type'];
      }
    }
    
    const response = await fetch(targetUrl, {
      method: req.method,
      headers,
      body: req.method !== 'GET' && req.method !== 'HEAD' && req.method !== 'DELETE' 
        ? JSON.stringify(req.body)
        : undefined,
      redirect: 'follow'
    });

    const setCookieHeaders = response.headers.getSetCookie?.() || [];
    for (const setCookie of setCookieHeaders) {
      await instanceData.jar.setCookie(setCookie, targetUrl);
    }

    const contentType = response.headers.get('Content-Type');
    
    // Special handling for HTML responses (like /web)
    if (contentType && contentType.includes('text/html')) {
      let html = await response.text();
      
      const proxyPath = `/odoo-proxy/${instanceId}`;
      
      // Rewrite all relative URLs to use the proxy path
      html = html.replace(/src=["']\/([^"']*?)["']/g, `src="${proxyPath}/$1"`);
      html = html.replace(/href=["']\/([^"']*?)["']/g, `href="${proxyPath}/$1"`);
      html = html.replace(/data-src=["']\/([^"']*?)["']/g, `data-src="${proxyPath}/$1"`);
      
      // Inject JavaScript to intercept all API calls
      const injectedScript = `
      <script>
        window.__ODOO_PROXY_BASE__ = '/odoo-proxy/${instanceId}';
        
        // Intercept fetch calls
        const originalFetch = window.fetch;
        window.fetch = function(resource, config) {
          let url = typeof resource === 'string' ? resource : resource.url;
          if (typeof url === 'string' && url.startsWith('/') && !url.includes('/odoo-proxy')) {
            url = '/odoo-proxy/${instanceId}' + url;
            if (typeof resource === 'string') {
              resource = url;
            } else {
              resource.url = url;
            }
          }
          return originalFetch.call(window, resource, config);
        };
        
        // Intercept XMLHttpRequest
        const originalOpen = XMLHttpRequest.prototype.open;
        XMLHttpRequest.prototype.open = function(method, url, ...rest) {
          if (typeof url === 'string' && url.startsWith('/') && !url.includes('/odoo-proxy')) {
            url = '/odoo-proxy/${instanceId}' + url;
          }
          return originalOpen.call(this, method, url, ...rest);
        };
      </script>
      `;
      
      // Insert script in head or body
      if (html.includes('</head>')) {
        html = html.replace('</head>', injectedScript + '</head>');
      } else if (html.includes('</body>')) {
        html = html.replace('</body>', injectedScript + '</body>');
      } else {
        html += injectedScript;
      }
      
      res.set('Content-Type', 'text/html; charset=utf-8');
      res.set('Access-Control-Allow-Origin', '*');
      res.status(response.status).send(html);
    } else {
      // For non-HTML responses, just pass through as binary
      if (contentType) res.set('Content-Type', contentType);
      const data = await response.arrayBuffer();
      res.status(response.status).send(Buffer.from(data));
    }
  } catch (error) {
    console.error('Proxy error:', error);
    res.status(500).send(`Error: ${error.message}`);
  }
});

const proxyRequest = async (instanceId, relPath, body, method = 'POST') => {
  const instanceData = getInstance(instanceId);
  if (!instanceData) {
    throw new Error(`Instance ${instanceId} not found or has been deleted`);
  }

  const targetUrl = `${instanceData.target}/${relPath}`;
  const cookieHeader = await instanceData.jar.getCookieString(targetUrl);
  const headers = {
    'Content-Type': 'application/json',
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
  };
  if (cookieHeader) {
    headers.Cookie = cookieHeader;
  }

  const response = await fetch(targetUrl, {
    method,
    headers,
    body: method === 'POST' ? JSON.stringify(body) : undefined,
  });

  const setCookieHeaders = response.headers.getSetCookie?.() || [];
  for (const setCookie of setCookieHeaders) {
    await instanceData.jar.setCookie(setCookie, targetUrl);
  }

  const text = await response.text();
  
  if (method === 'POST') {
    try {
      return { status: response.status, data: JSON.parse(text) };
    } catch (error) {
      return { status: response.status, data: { error: text } };
    }
  }
  
  return { status: response.status, data: text };
};

app.post('/:instance/*', async (req, res) => {
  try {
    const relPath = req.params[0];
    const instanceId = req.params.instance;
    console.log(`[${instanceId}] POST /${relPath}`, { body: JSON.stringify(req.body).substring(0, 200) });
    const { status, data } = await proxyRequest(instanceId, relPath, req.body, 'POST');
    console.log(`[${instanceId}] Response: ${status}`, { data: JSON.stringify(data).substring(0, 200) });
    res.status(status).json(data);
  } catch (error) {
    console.error('Proxy error:', error);
    res.status(500).json({ error: error.message || 'Proxy request failed' });
  }
});


app.get('/:instance/*', async (req, res) => {
  try {
    let relPath = req.params[0];
    if (req.url.includes('?')) {
      relPath = relPath + '?' + req.url.split('?')[1];
    }
    console.log(`[${req.params.instance}] GET /${relPath}`);
    const { status, data } = await proxyRequest(req.params.instance, relPath, null, 'GET');
    res.status(status).send(data);
  } catch (error) {
    console.error('Proxy error:', error);
    res.status(500).send(`Error: ${error.message}`);
  }
});

app.use((req, res) => {
  console.log(`[UNMATCHED] ${req.method} ${req.path}`);
  
  // Serve index.html for SPA routing
  const indexPath = path.join(__dirname, 'dist', 'index.html');
  if (fs.existsSync(indexPath) && req.method === 'GET') {
    res.sendFile(indexPath);
  } else {
    res.status(404).json({ error: 'Not found' });
  }
});

const PORT = process.env.PORT || 5174;
const server = app.listen(PORT, async () => {
  console.log(`Odoo backend proxy listening on http://localhost:${PORT}`);
  
  // Restore persisted session cookies on startup
  await restoreSessionCookies();
  
  // Save session cookies periodically (every 5 minutes)
  setInterval(persistSessionCookies, 5 * 60 * 1000);
});

// Proxy the Odoo bus (WebSocket) for instance subdomains.
// A fresh proxy is created per connection so a failure on one instance (e.g. an
// on-premise Odoo without WebSocket configured in Nginx) cannot corrupt the shared
// proxy state and take down WebSocket on other instances simultaneously.
server.on('upgrade', async (req, socket, head) => {
  // Absorb socket-level errors immediately so an ECONNRESET on one instance
  // cannot emit an unhandled 'error' event that affects other instances.
  socket.on('error', (err) => {
    console.warn(`[ws-proxy] socket error (${err.code || err.message}) — ignored`);
  });

  const instanceId = resolveInstanceIdFromHost(req.headers.host);
  if (!instanceId) return socket.destroy();
  const inst = getInstance(instanceId);
  if (!inst) return socket.destroy();
  try {
    const cookie = await inst.jar.getCookieString(inst.target + req.url);
    if (cookie) req.headers.cookie = cookie;
  } catch { /* ignore */ }

  const wsProxy = httpProxy.createProxyServer({ changeOrigin: true, secure: true });
  wsProxy.on('error', (err) => {
    console.warn(`[ws-proxy] ${instanceId} WebSocket failed (${err.message}) — Odoo will fall back to long-polling`);
    if (socket && !socket.destroyed) socket.destroy();
  });
  wsProxy.ws(req, socket, head, { target: inst.target });
});
