// OOP Utility Classes for Odoo Integration

// Predefined list of Odoo instances with their database names
export const ODOO_CONFIG = [
  {
    id: 'squadsm',
    url: 'https://squadsm.odoo.com',
    dbName: 'squadsm',
    label: 'Squad SM'
  },
  {
    id: 'squadts',
    url: 'https://squadts.odoo.com',
    dbName: 'squadts',
    label: 'Squad TS'
  },
  {
    id: 'squad-atlas',
    url: 'https://squad-atlas.odoo.com',
    dbName: 'squad-atlas',
    label: 'Squad Atlas'
  },
  {
    url: 'https://ascensivetechnologies.com',
    dbName: 'asccomm',
    label: 'Ascensive Technologies'
  }
];

/**
 * Extract domain name from URL (without path)
 * e.g., "https://squadsm.odoo.com/odoo" -> "https://squadsm.odoo.com"
 */
export const extractDomain = (url) => {
  if (!url) return '';
  try {
    const urlObj = new URL(url);
    return `${urlObj.protocol}//${urlObj.hostname}${urlObj.port ? ':' + urlObj.port : ''}`;
  } catch (e) {
    return '';
  }
};

/**
 * Check if two URLs have the same domain
 * e.g., "https://squadsm.odoo.com" and "https://squadsm.odoo.com/odoo" -> true
 */
export const isSameDomain = (url1, url2) => {
  const domain1 = extractDomain(url1);
  const domain2 = extractDomain(url2);
  return domain1 && domain2 && domain1.toLowerCase() === domain2.toLowerCase();
};

export const findOdooConfig = (url) => {
  if (!url) return null;
  const normalizedUrl = url.trim().toLowerCase();
  const domain = extractDomain(url).toLowerCase();
  
  // First try exact match
  const exactMatch = ODOO_CONFIG.find(config => config.url.toLowerCase() === normalizedUrl);
  if (exactMatch) return { ...exactMatch, url: extractDomain(url) };
  
  // Then try domain match
  const domainMatch = ODOO_CONFIG.find(config => 
    isSameDomain(config.url, url)
  );
  if (domainMatch) return { ...domainMatch, url: extractDomain(url) };
  
  return null;
};

export class OdooInstance {
  constructor(id, label, url, dbName, prefix) {
    this.id = id;
    this.label = label;
    this.url = url;
    this.dbName = dbName;
    this.prefix = prefix;
    this.availableModules = ['contacts', 'helpdesk', 'tasks'];
  }

  isValid() {
    return this.url && this.dbName && this.prefix;
  }
}

export class OdooAPIClient {
  constructor(instance) {
    this.instance = instance;
    this.userMap = {};
    this.userEmailMap = {}; // Map user IDs to emails
    this.currentUserEmail = null;
  }

  async authenticate(username, password) {
    try {
      // Use server API proxy endpoint to avoid CORS issues
      const authUrl = `/api/odoo/authenticate/${this.instance.id}`;
      
      const body = JSON.stringify({
        username,
        password,
        dbName: this.instance.dbName,
        url: this.instance.url  // Pass the Odoo URL to server
      });

      console.log('Auth request to:', authUrl);
      const resp = await fetch(authUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body
      });

      let data;
      try {
        data = await resp.json();
      } catch (parseErr) {
        const text = await resp.text();
        console.error('Failed to parse response as JSON. Response text:', text);
        throw new Error(`Invalid response from server: ${parseErr.message}`);
      }

      console.log('Auth response:', { status: resp.status, data });

      if (!resp.ok || data?.error) {
        const msg = data?.error || data?.message || `HTTP ${resp.status}`;
        throw new Error(msg);
      }

      // Extract email from auth response. If absent (common for on-premise Odoo),
      // keep the login as-is — App.jsx resolves the real email after fetchUserMap()
      // using the userId returned here, so the hardcoded domain is not needed.
      if (data?.email) {
        this.currentUserEmail = data.email;
        console.log(`✓ Got email from auth response: ${this.currentUserEmail}`);
      } else {
        this.currentUserEmail = username;
        console.log(`No email in auth response, will resolve from user map after login`);
      }

      return { success: true, user: data };
    } catch (err) {
      console.error('Authentication error:', err);
      throw err;
    }
  }

  async fetchUserMap() {
    try {
      console.log(`Fetching users from ${this.instance.label}...`);
      
      const body = JSON.stringify({
        method: 'call',
        params: {
          model: 'res.users',
          method: 'search_read',
          args: [[]],
          kwargs: { fields: ['name', 'id', 'email'], limit: 5000 },
          url: '/web/dataset/call_kw/res.users/search_read',
          _odooUrl: this.instance.url  // Pass URL for server to use if connection not found
        }
      });

      const userResp = await fetch(`/api/odoo/call/${this.instance.id}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body
      });

      const userData = await userResp.json();
      console.log(`User API Response from ${this.instance.label}:`, userData);

      if (userResp.ok && userData && userData.length > 0) {
        userData.forEach(user => {
          this.userMap[user.id] = user.name;
          this.userEmailMap[user.id] = user.email; // Store email mapping
          console.log(`  ✓ Mapped user ${user.id}: ${user.name} (${user.email})`);
        });
        console.log(`✓ Successfully fetched ${userData.length} users from ${this.instance.label}`);
        console.log(`  Current user email being used for filtering: "${this.currentUserEmail}"`);
        return this.userMap;
      } else {
        console.warn(`No user results returned from ${this.instance.label}. API response:`, userData);
        throw new Error('No user data in response');
      }
    } catch (err) {
      console.warn(`Could not fetch user mapping from ${this.instance.label}, creating minimal mock data:`, err.message);
      // FALLBACK: Create a minimal entry for the current logged-in user
      // This ensures filtering can at least match the logged-in user
      if (this.currentUserEmail) {
        // Try to find current user by email (in case we got it from auth response)
        const currentUserEntry = Object.entries(this.userEmailMap).find(([id, email]) => email === this.currentUserEmail);
        if (!currentUserEntry) {
          // Create a catch-all entry so filtering works
          this.userMap[0] = 'Current User';
          this.userEmailMap[0] = this.currentUserEmail;
          console.log(`  Created fallback mapping: user 0 = ${this.currentUserEmail}`);
        }
      }
      return this.userMap;
    }
  }

  getUserEmailMap() {
    return this.userEmailMap;
  }

  getUserMap() {
    return this.userMap;
  }

  getCurrentUserEmail() {
    return this.currentUserEmail;
  }

  async fetchRecords(model, fields, domainFilter = []) {
    try {
      // Fetch real records from Odoo API through server proxy to avoid CORS

      const body = JSON.stringify({
        method: 'call',
        params: {
          model,
          method: 'search_read',
          args: [domainFilter],
          kwargs: { fields, limit: 5000 },
          url: `/web/dataset/call_kw/${model}/search_read`,
          _odooUrl: this.instance.url  // Pass URL for server to use if connection not found
        }
      });

      const resp = await fetch(`/api/odoo/call/${this.instance.id}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body
      });

      const data = await resp.json();

      if (resp.ok && data) {
        console.log(`✓ Found ${data.length || 0} ${model} records from ${this.instance.label}`);
        return data || [];
      } else if (data?.error) {
        console.error(`✗ API Error from ${this.instance.label}:`, data.error);
      }
      return [];
    } catch (err) {
      console.error(`Error fetching from ${this.instance.label}:`, err);
      return [];
    }
  }

  async fetchFields(model) {
    try {
      const body = JSON.stringify({
        method: 'call',
        params: {
          model,
          method: 'fields_get',
          args: [],
          kwargs: {},
          url: `/web/dataset/call_kw/${model}/fields_get`,
          _odooUrl: this.instance.url  // Pass URL for server to use if connection not found
        }
      });

      const resp = await fetch(`/api/odoo/call/${this.instance.id}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body
      });

      const data = await resp.json();
      return data || {};
    } catch (err) {
      console.error(`Error fetching fields for ${model}:`, err);
      return {};
    }
  }
}

export class RecordFilter {
  static filterByUserId(records, userId, fieldKey = 'user_id') {
    return records.filter(record => {
      const v = record[fieldKey];
      if (!v) return false;
      const id = Array.isArray(v) ? v[0] : v;
      return id === userId;
    });
  }

  static filterTasksByUserId(records, userId) {
    return records.filter(record => {
      const ids = record.user_ids;
      if (!ids || ids.length === 0) return false;
      return ids.some(u => (Array.isArray(u) ? u[0] : u) === userId);
    });
  }

  static filterByAssignedUser(records, userId, fieldKey = 'user_id') {
    return records.filter(record => {
      const assignedValue = record[fieldKey];
      if (!assignedValue) return false;

      const assignedUserId = Array.isArray(assignedValue) ? assignedValue[0] : assignedValue;
      return assignedUserId === userId;
    });
  }

  static filterByAssignedUserEmail(records, userEmail, userEmailMap, fieldKey = 'user_id') {
    console.log(`🔍 Filtering ${records.length} records by email: ${userEmail}, Field: ${fieldKey}`);
    console.log('📋 Available user email mappings:', userEmailMap);
    
    const normalizeEmail = (email) => {
      if (!email) return '';
      return email.toLowerCase().split('@')[0];
    };

    const userEmailPrefix = normalizeEmail(userEmail);
    console.log(`  User email prefix for matching: "${userEmailPrefix}"`);
    
    const filtered = records.filter(record => {
      const assignedValue = record[fieldKey];
      if (!assignedValue) {
        console.log(`  ❌ Record ${record.id}: No ${fieldKey} assigned`);
        return false;
      }

      const assignedUserId = Array.isArray(assignedValue) ? assignedValue[0] : assignedValue;
      const assignedUserEmail = userEmailMap[assignedUserId];
      
      // Try exact match first
      let matches = assignedUserEmail && assignedUserEmail.toLowerCase() === userEmail.toLowerCase();
      
      // If no exact match, try matching email prefix (before @)
      if (!matches && assignedUserEmail && userEmailPrefix) {
        const assignedPrefix = normalizeEmail(assignedUserEmail);
        matches = assignedPrefix === userEmailPrefix;
        console.log(`  ${matches ? '✅' : '❌'} Record ${record.id}: Prefix match - "${assignedPrefix}" vs "${userEmailPrefix}"`);
      } else {
        console.log(`  ${matches ? '✅' : '❌'} Record ${record.id}: User ${assignedUserId} has email "${assignedUserEmail}" vs "${userEmail}"`);
      }
      
      return matches;
    });
    
    console.log(`📊 Filtered result: ${filtered.length}/${records.length} records match email`);
    return filtered;
  }

  static filterTasksByAssignedUser(records, userId) {
    return records.filter(record => {
      const userIds = record.user_ids;
      if (!userIds || userIds.length === 0) return false;

      return userIds.some(u => {
        const uid = Array.isArray(u) ? u[0] : u;
        return uid === userId;
      });
    });
  }

  static filterTasksByAssignedUserEmail(records, userEmail, userEmailMap) {
    console.log(`🔍 Filtering ${records.length} tasks by email: ${userEmail}`);
    console.log('📋 Available user email mappings:', userEmailMap);
    
    const normalizeEmail = (email) => {
      if (!email) return '';
      return email.toLowerCase().split('@')[0];
    };

    const userEmailPrefix = normalizeEmail(userEmail);
    console.log(`  User email prefix for matching: "${userEmailPrefix}"`);
    
    const filtered = records.filter(record => {
      const userIds = record.user_ids;
      if (!userIds || userIds.length === 0) {
        console.log(`  ❌ Task ${record.id}: No user_ids assigned`);
        return false;
      }

      const matches = userIds.some(u => {
        const uid = Array.isArray(u) ? u[0] : u;
        const assignedUserEmail = userEmailMap[uid];
        
        // Try exact match first
        let isMatch = assignedUserEmail && assignedUserEmail.toLowerCase() === userEmail.toLowerCase();
        
        // If no exact match, try prefix match
        if (!isMatch && assignedUserEmail && userEmailPrefix) {
          const assignedPrefix = normalizeEmail(assignedUserEmail);
          isMatch = assignedPrefix === userEmailPrefix;
        }
        
        console.log(`    ${isMatch ? '✅' : '❌'} Task ${record.id}: User ${uid} email "${assignedUserEmail}"`);
        return isMatch;
      });
      
      return matches;
    });
    
    console.log(`📊 Filtered result: ${filtered.length}/${records.length} tasks match email`);
    return filtered;
  }

  static enrichWithMetadata(records, instance, model) {
    return records.map(rec => ({
      ...rec,
      _instanceId: instance.id,
      _instance: instance.label,
      _model: model,
      _prefix: instance.prefix,
      _odooUrl: instance.url,
      _dbName: instance.dbName,
      _userMap: instance.userMap || {},
      _userEmailMap: instance.userEmailMap || {}
    }));
  }
}
