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
  }
];

export const findOdooConfig = (url) => {
  if (!url) return null;
  const normalizedUrl = url.trim().toLowerCase();
  return ODOO_CONFIG.find(config => config.url.toLowerCase() === normalizedUrl);
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
      const authUrl = `${this.instance.prefix}/web/session/authenticate`;
      const body = JSON.stringify({
        jsonrpc: '2.0',
        method: 'call',
        id: 0,
        params: {
          db: this.instance.dbName,
          login: username,
          password: password
        }
      });

      console.log('Auth request to:', authUrl);
      const resp = await fetch(authUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body
      });

      const data = await resp.json();
      console.log('Auth response:', { status: resp.status, hasError: !!data?.error, result: data?.result });

      if (!resp.ok || data?.error) {
        const msg = data?.error?.data?.message || data?.error?.message || `HTTP ${resp.status}`;
        throw new Error(msg);
      }

      // Extract email from auth response or generate from username
      const authResult = data.result;
      if (authResult?.email) {
        this.currentUserEmail = authResult.email;
        console.log(`✓ Got email from auth response: ${this.currentUserEmail}`);
      } else {
        this.currentUserEmail = username.includes('@') ? username : (username + '@squadsm.odoo.com');
        console.log(`Generated email from username: ${this.currentUserEmail}`);
      }

      return { success: true, user: authResult };
    } catch (err) {
      console.error('Authentication error:', err);
      throw err;
    }
  }

  async fetchUserMap() {
    try {
      console.log(`Fetching users from ${this.instance.label} at ${this.instance.prefix}...`);
      const userUrl = `${this.instance.prefix}/web/dataset/call_kw/res.users/search_read`;
      const userBody = JSON.stringify({
        jsonrpc: '2.0',
        method: 'call',
        params: {
          model: 'res.users',
          method: 'search_read',
          args: [[]],
          kwargs: { fields: ['name', 'id', 'email'], limit: 5000 }
        }
      });

      const userResp = await fetch(userUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: userBody
      });

      const userData = await userResp.json();
      console.log(`User API Response from ${this.instance.label}:`, userData);

      if (userData?.result && userData.result.length > 0) {
        userData.result.forEach(user => {
          this.userMap[user.id] = user.name;
          this.userEmailMap[user.id] = user.email; // Store email mapping
          console.log(`  ✓ Mapped user ${user.id}: ${user.name} (${user.email})`);
        });
        console.log(`✓ Successfully fetched ${userData.result.length} users from ${this.instance.label}`);
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
      // Fetch real records from Odoo API (removed TEST MODE mock data)

      const dataUrl = `${this.instance.prefix}/web/dataset/call_kw/${model}/search_read`;
      const dataBody = JSON.stringify({
        jsonrpc: '2.0',
        method: 'call',
        params: {
          model,
          method: 'search_read',
          args: [domainFilter],
          kwargs: { fields, limit: 5000 }
        }
      });

      const resp = await fetch(dataUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: dataBody
      });

      const data = await resp.json();

      if (resp.ok && !data?.error && data?.result) {
        console.log(`✓ Found ${data.result.length} ${model} records from ${this.instance.label}`);
        return data.result;
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
      const fieldsUrl = `${this.instance.prefix}/web/dataset/call_kw/${model}/fields_get`;
      const body = JSON.stringify({
        jsonrpc: '2.0',
        method: 'call',
        params: { model, method: 'fields_get', args: [], kwargs: {} }
      });

      const resp = await fetch(fieldsUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body
      });

      const data = await resp.json();
      return data?.result || {};
    } catch (err) {
      console.error(`Error fetching fields for ${model}:`, err);
      return {};
    }
  }
}

export class RecordFilter {
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
