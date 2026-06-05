import { useState, useEffect } from 'react';
import { PieChart, Pie, Cell, Tooltip, ResponsiveContainer } from 'recharts';
import * as XLSX from 'xlsx';

// Default instances for backward compatibility
const DEFAULT_INSTANCES = [
  { id: 'squadsm', label: 'SquadSM', value: 'https://squadsm.odoo.com', prefix: 'http://localhost:5174/squadsm', availableModules: ['contacts', 'helpdesk', 'tasks'] },
  { id: 'squadts', label: 'SquadTS', value: 'https://squadts.odoo.com', prefix: 'http://localhost:5174/squadts', availableModules: ['contacts', 'helpdesk', 'tasks'] },
  { id: 'squad-atlas', label: 'Squad Atlas', value: 'https://squad-atlas.odoo.com', prefix: 'http://localhost:5174/squad-atlas', availableModules: ['contacts', 'helpdesk', 'tasks'] },
];

let ODOO_INSTANCES = DEFAULT_INSTANCES;

// Model to API model mapping
const MODEL_MAPPING = {
  contacts: 'res.partner',
  companies: 'res.partner',
  tasks: 'project.task',
  helpdesk: 'helpdesk.ticket',
};

// Priority of fields to include (in order of preference)
const FIELD_PRIORITY = {
  'name': 10,
  'email': 9,
  'phone': 8,
  'mobile': 8,
  'user_id': 8,
  'user_ids': 8,
  'stage_id': 8,
  'priority': 7,
  'date_deadline': 7,
  'create_date': 6,
  'write_date': 5,
  'street': 5,
  'city': 5,
  'country_id': 5,
  'company_id': 5,
  'parent_id': 5,
  'vat': 5,
  'website': 5,
  'is_company': 4,
  'active': 7,
  'description': 4,
  'notes': 4,
  'tag_ids': 4,
  'category_ids': 4,
};

// Label overrides for specific fields (to override Odoo's field.string)
const FIELD_LABEL_OVERRIDES = {
  'user_ids': 'Assigned To',
  'user_id': 'Assigned To',
};

// Initialize with default columns immediately
let COLUMN_CONFIG = {
  contacts: [
    { key: 'instance', label: 'Instance', groupable: true, important: true },
    { key: 'name', label: 'Name', groupable: true, important: true },
    { key: 'email', label: 'Email', groupable: false, important: true },
    { key: 'phone', label: 'Phone', groupable: false, important: true },
    { key: 'mobile', label: 'Mobile', groupable: false, important: true },
    { key: 'create_date', label: 'Created Date', groupable: true, important: true },
    { key: 'user_id', label: 'Sales Person', groupable: true, important: true },
    { key: 'active', label: 'Active', groupable: true, important: true },
  ],
  companies: [
    { key: 'instance', label: 'Instance', groupable: true, important: true },
    { key: 'name', label: 'Name', groupable: true, important: true },
    { key: 'email', label: 'Email', groupable: false, important: true },
    { key: 'phone', label: 'Phone', groupable: false, important: true },
    { key: 'mobile', label: 'Mobile', groupable: false, important: true },
    { key: 'create_date', label: 'Created Date', groupable: true, important: true },
    { key: 'user_id', label: 'Account Manager', groupable: true, important: true },
    { key: 'active', label: 'Active', groupable: true, important: true },
  ],
  tasks: [
    { key: 'instance', label: 'Instance', groupable: true, important: true },
    { key: 'name', label: 'Name', groupable: true, important: true },
    { key: 'partner_id', label: 'Customer', groupable: true, important: true },
    { key: 'project_id', label: 'Project', groupable: true, important: true },
    { key: 'date_deadline', label: 'Deadline', groupable: true, important: true },
    { key: 'create_date', label: 'Created Date', groupable: true, important: false },
    { key: 'user_ids', label: 'Assigned To', groupable: true, important: true },
    { key: 'stage_id', label: 'Stage', groupable: true, important: true },
    { key: 'priority', label: 'Priority', groupable: true, important: true },
  ],
  helpdesk: [
    { key: 'instance', label: 'Instance', groupable: true, important: true },
    { key: 'name', label: 'Name', groupable: true, important: true },
    { key: 'partner_id', label: 'Customer', groupable: true, important: true },
    { key: 'team_id', label: 'Helpdesk Team', groupable: true, important: true },
    { key: 'create_date', label: 'Created Date', groupable: true, important: true },
    { key: 'user_id', label: 'Assigned To', groupable: true, important: true },
    { key: 'stage_id', label: 'Stage', groupable: true, important: true },
    { key: 'priority', label: 'Priority', groupable: true, important: true },
   
  ],
};

// Function to fetch available fields from Odoo API
const fetchFieldsFromOdoo = async (instance, model) => {
  try {
    const fieldsUrl = `${instance.prefix}/web/dataset/call_kw/${model}/fields_get`;
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
    if (data?.result) {
      return data.result;
    }
    return {};
  } catch (e) {
    console.error(`Error fetching fields for ${model}:`, e);
    return {};
  }
};

// Function to build column config from fetched fields
const buildColumnConfigFromFields = (fieldDefs, modelName, view) => {
  const columns = [];
  
  // Exclude certain field types and internal fields
  const excludeFieldTypes = ['binary', 'html', 'monetary', 'json'];
  const excludePatterns = [/^__/, /^_/, /^x_/];
  
  // Score each field based on type and priority
  const scoredFields = Object.entries(fieldDefs)
    .filter(([key, field]) => {
      // Skip internal fields
      if (excludePatterns.some(pattern => pattern.test(key))) return false;
      // Skip certain field types
      if (excludeFieldTypes.includes(field.type)) return false;
      // Skip readonly computed fields
      if (field.readonly && field.compute) return false;
      return true;
    })
    .map(([key, field]) => {
      let score = FIELD_PRIORITY[key] || 3;
      
      // Boost score for commonly useful field types
      if (field.type === 'char' || field.type === 'text') score += 2;
      if (field.type === 'many2one' || field.type === 'many2many') score += 1;
      if (field.type === 'selection') score += 1;
      if (field.type === 'boolean') score += 1;
      if (field.type === 'date' || field.type === 'datetime') score += 2;
      
      // Penalize certain field types
      if (field.type === 'integer') score -= 1;
      
      return { key, field, score };
    })
    .sort((a, b) => b.score - a.score);
  
  // Select top 10 fields (plus instance field)
  const selectedFields = scoredFields.slice(0, 10);
  
  // Add instance field
  columns.push({ key: 'instance', label: 'Instance', groupable: true, important: true });
  
  // Add selected fields
  selectedFields.forEach(({ key, field }) => {
    const groupableTypes = ['char', 'text', 'many2one', 'selection', 'boolean', 'date', 'datetime'];
    const label = FIELD_LABEL_OVERRIDES[key] || field.string || key;
    columns.push({
      key,
      label,
      groupable: groupableTypes.includes(field.type),
      important: true
    });
  });
  
  return columns;
};

// Get default columns for a view
const getDefaultColumns = (view) => {
  return COLUMN_CONFIG[view] ? COLUMN_CONFIG[view].filter(col => !col.exclude).map(col => col.key) : [];
};

function LoginFlow({ onAllAuthenticated }) {
  const [connections, setConnections] = useState([]);
  const [showAddForm, setShowAddForm] = useState(false);
  const [newUrl, setNewUrl] = useState('');
  const [newLabel, setNewLabel] = useState('');
  const [newDbName, setNewDbName] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [addError, setAddError] = useState('');
  const [authenticatedInstances, setAuthenticatedInstances] = useState({});
  const [connectionCredentials, setConnectionCredentials] = useState({});

  // Load connections on mount
  useEffect(() => {
    loadConnections();
  }, []);

  const loadConnections = async () => {
    try {
      setLoading(true);
      const response = await fetch('http://localhost:5174/api/connections');
      const data = await response.json();
      
      console.log('Loaded connections from API:', data);
      
      // Convert connections to instance format with prefix
      const instances = data.map(conn => ({
        ...conn,
        value: conn.url,
        prefix: `http://localhost:5174/${conn.id}`
      }));
      
      console.log('Processed instances:', instances);
      
      // Combine with default instances
      ODOO_INSTANCES = [...DEFAULT_INSTANCES, ...instances];
      setConnections(instances);
    } catch (err) {
      console.error('Failed to load connections:', err);
    } finally {
      setLoading(false);
    }
  };

  const addConnection = async () => {
    setAddError('');
    
    // Validate inputs
    if (!newUrl.trim()) {
      setAddError('URL is required');
      return;
    }
    
    if (!newLabel.trim()) {
      setAddError('Label is required');
      return;
    }
    
    if (!newDbName.trim()) {
      setAddError('Database name is required');
      return;
    }
    
    if (!newUrl.includes('odoo.com')) {
      setAddError('URL must contain "odoo.com"');
      return;
    }

    try {
      setLoading(true);
      const response = await fetch('http://localhost:5174/api/connections', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ 
          url: newUrl, 
          label: newLabel,
          dbName: newDbName
        })
      });

      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.error || 'Failed to add connection');
      }

      // Reload connections from API to get updated list
      await loadConnections();
      
      setNewUrl('');
      setNewLabel('');
      setNewDbName('');
      setShowAddForm(false);
    } catch (err) {
      setAddError(err.message || 'Failed to add connection');
    } finally {
      setLoading(false);
    }
  };

  const deleteConnection = async (id) => {
    if (!confirm('Are you sure you want to delete this connection?')) return;

    try {
      setLoading(true);
      const response = await fetch(`http://localhost:5174/api/connections/${id}`, {
        method: 'DELETE'
      });

      if (!response.ok) {
        throw new Error('Failed to delete connection');
      }

      // Reload connections from API to get updated list
      await loadConnections();
      
      // Remove from authenticated instances
      const newAuth = { ...authenticatedInstances };
      delete newAuth[id];
      setAuthenticatedInstances(newAuth);
    } catch (err) {
      setError(err.message || 'Failed to delete connection');
    } finally {
      setLoading(false);
    }
  };

  const authenticate = async (connectionId) => {
    setError('');
    const creds = connectionCredentials[connectionId];
    
    if (!creds?.username || !creds?.password) {
      setError(`Please enter username and password for this connection`);
      return;
    }

    try {
      setLoading(true);
      const connection = connections.find(c => c.id === connectionId);
      if (!connection) {
        throw new Error('Connection not found');
      }
      
      const dbName = connection.dbName;
      
      console.log('Authentication details:', {
        connection: connection.label,
        url: connection.value,
        prefix: connection.prefix,
        dbName: dbName,
        username: creds.username
      });
      
      if (!dbName) {
        throw new Error('Database name is missing. Please delete and re-add this connection with the correct database name.');
      }
      
      const authUrl = `${connection.prefix}/web/session/authenticate`;
      const body = JSON.stringify({ 
        jsonrpc: '2.0', 
        method: 'call',
        id: 0,
        params: { 
          db: dbName, 
          login: creds.username, 
          password: creds.password
        }
      });

      console.log('Sending auth request to:', authUrl);
      const resp = await fetch(authUrl, { 
        method: 'POST', 
        headers: { 'Content-Type': 'application/json' }, 
        body
      });
      
      const data = await resp.json();
      
      console.log('Auth response:', {
        status: resp.status,
        ok: resp.ok,
        hasError: !!data?.error,
        error: data?.error
      });

      if (!resp.ok || data?.error) {
        const msg = data?.error?.data?.message || data?.error?.message || `HTTP ${resp.status}`;
        throw new Error(msg);
      }

      const newAuth = { 
        ...authenticatedInstances, 
        [connectionId]: { 
          username: creds.username, 
          password: creds.password, 
          instance: connection
        } 
      };
      setAuthenticatedInstances(newAuth);

      // Clear credentials after successful auth
      setConnectionCredentials({
        ...connectionCredentials,
        [connectionId]: { username: '', password: '' }
      });
    } catch (err) {
      setError(err.message || 'Authentication failed');
      console.error('Authentication error:', err);
    } finally {
      setLoading(false);
    }
  };

  const goToDashboard = async () => {
    // Fetch field definitions from first authenticated instance
    for (const [instId, authData] of Object.entries(authenticatedInstances)) {
      try {
        console.log(`Fetching field definitions from ${authData.instance.label}...`);
        
        const partnerFields = await fetchFieldsFromOdoo(authData.instance, 'res.partner');
        if (Object.keys(partnerFields).length > 0) {
          const contactsConfig = buildColumnConfigFromFields(partnerFields, 'res.partner', 'contacts');
          const companiesConfig = buildColumnConfigFromFields(partnerFields, 'res.partner', 'companies');
          
          if (contactsConfig.length > 0) {
            COLUMN_CONFIG.contacts = contactsConfig;
            COLUMN_CONFIG.companies = companiesConfig;
          }
          
          const taskFields = await fetchFieldsFromOdoo(authData.instance, 'project.task');
          if (Object.keys(taskFields).length > 0) {
            const tasksConfig = buildColumnConfigFromFields(taskFields, 'project.task', 'tasks');
            if (tasksConfig.length > 0) {
              COLUMN_CONFIG.tasks = tasksConfig;
            }
          }
          
          const helpdeskFields = await fetchFieldsFromOdoo(authData.instance, 'helpdesk.ticket');
          if (Object.keys(helpdeskFields).length > 0) {
            const helpdeskConfig = buildColumnConfigFromFields(helpdeskFields, 'helpdesk.ticket', 'helpdesk');
            if (helpdeskConfig.length > 0) {
              COLUMN_CONFIG.helpdesk = helpdeskConfig;
            }
          }
          
          break;
        }
      } catch (err) {
        console.warn(`Failed to fetch fields from ${authData.instance.label}:`, err);
      }
    }
    
    onAllAuthenticated(authenticatedInstances);
  };

  const allConnections = connections;
  const isAtLeastOneAuthenticated = Object.keys(authenticatedInstances).length >= 1;

  return (
    <div className="login-container">
      <div className="login-card">
        <h1>Odoo Multi-Instance Authentication</h1>
        
        {/* Add Connection Button */}
        <button 
          className="add-connection-btn" 
          onClick={() => setShowAddForm(!showAddForm)}
          disabled={loading}
        >
          + Add Odoo Connection
        </button>

        {/* Add Connection Form */}
        {showAddForm && (
          <div className="add-connection-form">
            <h3>Add New Odoo Connection</h3>
            <input 
              className="login-input" 
              type="text" 
              value={newUrl} 
              placeholder="Odoo URL (must contain odoo.com)"
              onChange={(e) => setNewUrl(e.target.value)}
            />
            <input 
              className="login-input" 
              type="text" 
              value={newLabel} 
              placeholder="Connection Label"
              onChange={(e) => setNewLabel(e.target.value)}
            />
            <input 
              className="login-input" 
              type="text" 
              value={newDbName} 
              placeholder="Database Name (e.g., squadts, squadsm, squad-atlas, etc.)"
              onChange={(e) => setNewDbName(e.target.value)}
            />
            {addError && <p className="error">{addError}</p>}
            <div className="form-buttons">
              <button 
                className="login-btn" 
                onClick={addConnection}
                disabled={loading}
              >
                {loading ? 'Adding...' : 'Add Connection'}
              </button>
              <button 
                className="skip-btn" 
                onClick={() => setShowAddForm(false)}
                disabled={loading}
              >
                Cancel
              </button>
            </div>
          </div>
        )}

        {error && <p className="error">{error}</p>}

        {/* Connections Grid */}
        <div className="connections-grid">
          {allConnections.length === 0 ? (
            <p className="no-connections">No connections available. Add a new connection to get started.</p>
          ) : (
            allConnections.map(connection => {
              const isAuthenticated = authenticatedInstances[connection.id];
              const creds = connectionCredentials[connection.id] || { username: '', password: '' };
              
              return (
                <div key={connection.id} className="connection-box">
                  <div className="connection-header">
                    <h3>{connection.label}</h3>
                    <button 
                      className="delete-btn"
                      onClick={() => deleteConnection(connection.id)}
                      disabled={loading}
                      title="Delete connection"
                    >
                      ✕
                    </button>
                  </div>

                  {isAuthenticated ? (
                    <div className="auth-success-box">
                      <p>✓ Authenticated</p>
                      <p className="auth-user">{isAuthenticated.username}</p>
                      {connection.dbName && <p style={{ fontSize: '0.85rem', color: '#666', marginTop: '5px' }}>DB: {connection.dbName}</p>}
                    </div>
                  ) : (
                    <>
                      {connection.dbName && <p style={{ fontSize: '0.85rem', color: '#999', marginBottom: '10px' }}>Database: <strong>{connection.dbName}</strong></p>}
                      <input 
                        className="login-input" 
                        type="text" 
                        value={creds.username} 
                        placeholder="User ID"
                        onChange={(e) => setConnectionCredentials({
                          ...connectionCredentials,
                          [connection.id]: { ...creds, username: e.target.value }
                        })}
                        disabled={loading}
                      />
                      <input 
                        className="login-input" 
                        type="password" 
                        value={creds.password} 
                        placeholder="Password"
                        onChange={(e) => setConnectionCredentials({
                          ...connectionCredentials,
                          [connection.id]: { ...creds, password: e.target.value }
                        })}
                        disabled={loading}
                      />
                      <button 
                        className="login-btn" 
                        onClick={() => authenticate(connection.id)}
                        disabled={loading || !creds.username || !creds.password}
                      >
                        {loading ? 'Authenticating...' : 'Login'}
                      </button>
                    </>
                  )}
                </div>
              );
            })
          )}
        </div>

        {allConnections.length > 0 && isAtLeastOneAuthenticated && (
          <div className="all-auth-buttons">
            <button className="login-btn proceed-btn" onClick={goToDashboard}>
              ✓ Proceed to Dashboard
            </button>
          </div>
        )}

        {allConnections.length > 0 && !isAtLeastOneAuthenticated && (
          <div className="auth-status">
            <h3>Authentication Status:</h3>
            <p className="auth-status-note">Authenticate at least 1 connection to proceed to dashboard</p>
            {allConnections.map((inst) => (
              <p key={inst.id} className={authenticatedInstances[inst.id] ? 'authenticated' : 'pending'}>
                {authenticatedInstances[inst.id] ? '✓' : '○'} {inst.label}
              </p>
            ))}
          </div>
        )}

        {allConnections.length > 0 && isAtLeastOneAuthenticated && (
          <div className="auth-status">
            <h3>Authentication Status:</h3>
            {allConnections.map((inst) => (
              <p key={inst.id} className={authenticatedInstances[inst.id] ? 'authenticated' : 'pending'}>
                {authenticatedInstances[inst.id] ? '✓' : '○'} {inst.label}
              </p>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function ConsolidatedDashboard({ authenticatedInstances, onLogout }) {
  const [activeView, setActiveView] = useState('helpdesk');
  const [records, setRecords] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [selectedInstance, setSelectedInstance] = useState('all');
  const [currentPage, setCurrentPage] = useState(1);
  const [pageSize] = useState(10);
  const [statusFilter, setStatusFilter] = useState('all');
  const [assignedToFilter, setAssignedToFilter] = useState('all');
  const [salespersonFilter, setSalespersonFilter] = useState('all');
  const [helpdeskStatusFilter, setHelpdeskStatusFilter] = useState('solved');
  const [taskStatusFilter, setTaskStatusFilter] = useState('completed');
  const [sortBy, setSortBy] = useState('name');
  const [sortOrder, setSortOrder] = useState('asc');
  const [groupBy, setGroupBy] = useState(null);
  const [expandedGroups, setExpandedGroups] = useState({});
  
  // Initialize selected columns - COLUMN_CONFIG is always populated with defaults
  const [selectedColumns, setSelectedColumns] = useState({
    contacts: getDefaultColumns('contacts'),
    companies: getDefaultColumns('companies'),
    tasks: getDefaultColumns('tasks'),
    helpdesk: getDefaultColumns('helpdesk'),
  });
  
  const [showColumnSelector, setShowColumnSelector] = useState(false);
  const [showPieChart, setShowPieChart] = useState(false);
  const [pieChartColumn, setPieChartColumn] = useState(null);

  // Load helpdesk records with Solved status filter on component mount
  useEffect(() => {
    fetchRecordsForView('helpdesk');
  }, []);

  // Helper function to toggle column selection
  const toggleColumn = (columnKey) => {
    setSelectedColumns(prev => ({
      ...prev,
      [activeView]: prev[activeView].includes(columnKey)
        ? prev[activeView].filter(col => col !== columnKey)
        : [...prev[activeView], columnKey]
    }));
  };

  // Get columns available for grouping based on selected columns
  const getGroupableColumns = () => {
    const viewConfig = COLUMN_CONFIG[activeView] || [];
    return viewConfig.filter(col => 
      selectedColumns[activeView].includes(col.key) && col.groupable && col.key !== 'instance'
    );
  };

  // Get all important columns for export
  const getImportantColumns = () => {
    const viewConfig = COLUMN_CONFIG[activeView] || [];
    return viewConfig.filter(col => col.important).map(col => col.key);
  };

  // Reset groupBy if the currently selected group column is not in selected columns
  const validateGroupBy = (value) => {
    const groupableColumns = getGroupableColumns();
    const isValidGroupBy = !value || groupableColumns.some(col => col.key === value);
    if (!isValidGroupBy && value) {
      setGroupBy(null);
    }
  };

  const fetchRecordsForView = async (view) => {
    setError('');
    setLoading(true);
    setRecords([]);
    setCurrentPage(1);
    setSelectedInstance('all');
    setStatusFilter('all');
    setAssignedToFilter('all');
    setSalespersonFilter('all');
    setHelpdeskStatusFilter('all');
    setTaskStatusFilter('all');
    setSortBy('name');
    setSortOrder('asc');
    setGroupBy(null);
    setExpandedGroups({});
    setShowColumnSelector(false);
    try {
      let model = '', fields = [], domainFilter = [];
      if (view === 'contacts') {
        model = 'res.partner';
        fields = ['name', 'create_date', 'email', 'phone', 'mobile', 'user_id', 'active'];
        domainFilter = [['is_company', '=', false]];
      } else if (view === 'companies') {
        model = 'res.partner';
        fields = ['name', 'create_date', 'email', 'phone', 'mobile', 'user_id', 'active'];
        domainFilter = [['is_company', '=', true]];
      } else if (view === 'helpdesk') {
        model = 'helpdesk.ticket';
        fields = ['name', 'create_date', 'partner_id', 'team_id', 'user_id', 'stage_id', 'priority'];
        domainFilter = [];
      } else if (view === 'tasks') {
        model = 'project.task';
        fields = ['name', 'user_ids', 'date_deadline', 'create_date', 'stage_id', 'priority', 'partner_id', 'project_id'];
        domainFilter = [];
      }

      let allRecords = [];

      for (const [instId, authData] of Object.entries(authenticatedInstances)) {
        const instance = authData.instance;
        console.log('Processing instance:', { instId, label: instance.label, hasValue: !!instance.value, value: instance.value, prefix: instance.prefix });
        const moduleToCheck = view === 'companies' ? 'contacts' : view;
        if (!instance.availableModules.includes(moduleToCheck)) {
          console.log(`Skipping instance ${instance.label}: module ${moduleToCheck} not available`);
          continue;
        }

        try {
          // Fetch user mapping for this instance (for user_ids display)
          let userMap = {};
          try {
            const userUrl = `${instance.prefix}/web/dataset/call_kw/res.users/search_read`;
            const userBody = JSON.stringify({
              jsonrpc: '2.0',
              method: 'call',
              params: { model: 'res.users', method: 'search_read', args: [[]], kwargs: { fields: ['name', 'id'], limit: 5000 } }
            });
            const userResp = await fetch(userUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: userBody });
            const userData = await userResp.json();
            if (userData?.result) {
              console.log(`Fetched ${userData.result.length} users from ${instance.label}:`, userData.result.slice(0, 5));
              userData.result.forEach(user => {
                userMap[user.id] = user.name;
              });
            } else {
              console.warn(`No users found in response from ${instance.label}:`, userData);
            }
          } catch (e) {
            console.warn(`Could not fetch user mapping from ${instance.label}:`, e);
          }
          console.log(`User map for ${instance.label}:`, userMap);

          const dataUrl = `${instance.prefix}/web/dataset/call_kw/${model}/search_read`;
          const dataBody = JSON.stringify({
            jsonrpc: '2.0',
            method: 'call',
            params: { model, method: 'search_read', args: [domainFilter], kwargs: { fields, limit: 5000 } }
          });
          console.log(`Fetching ${view} from ${instance.label}:`, { model, domainFilter, fields });
          const resp = await fetch(dataUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: dataBody });
          const text = await resp.text();
          console.log(`Raw response from ${instance.label}:`, text.substring(0, 500));
          let data = null;
          try { data = JSON.parse(text); } catch (e) { 
            console.error(`JSON parse error from ${instance.label}:`, e);
          }
          console.log(`Response from ${instance.label} (${view}):`, { status: resp.ok, resultCount: data?.result?.length, resultExists: !!data?.result, error: data?.error });
          if (resp.ok && !data?.error) {
            if (data?.result && data.result.length > 0) {
              console.log(`✓ Found ${data.result.length} ${view} records from ${instance.label}`);
              console.log('Instance details for records:', { id: instance.id, label: instance.label, value: instance.value, prefix: instance.prefix });
              const recordsWithInstance = data.result.map(rec => ({ 
                ...rec, 
                _instanceId: instance.id,
                _instance: instance.label, 
                _model: model, 
                _prefix: instance.prefix, 
                _odooUrl: instance.value,
                _userMap: userMap
              }));
              console.log('Sample record with metadata:', recordsWithInstance[0]);
              allRecords = [...allRecords, ...recordsWithInstance];
            } else {
              console.log(`⚠ No ${view} records found in ${instance.label} (empty result)`);
            }
          } else if (data?.error) {
            console.error(`✗ API Error from ${instance.label} (${model}):`, data.error);
          }
        } catch (e) {
          console.error(`Error fetching from ${instance.label}:`, e);
        }
      }

      setRecords(allRecords);
      setActiveView(view);
    } catch (e) {
      setError(e.message || 'Failed to fetch records');
    } finally {
      setLoading(false);
    }
  };

  const openRecordInOdoo = (record) => {
    console.log('openRecordInOdoo called with record:', record);
    console.log('Record metadata:', {
      _odooUrl: record._odooUrl,
      _model: record._model,
      id: record.id,
      _instance: record._instance,
      name: record.name
    });
    
    if (!record._odooUrl) {
      console.error('ERROR: _odooUrl is missing from record!');
      return;
    }
    
    if (!record.id) {
      console.error('ERROR: record id is missing!');
      return;
    }
    
    // Open directly from the Odoo instance URL - use proper Odoo URL format
    // Format: /web#model=MODEL&id=RECORD_ID&view_type=form
    const recordUrl = `${record._odooUrl}/web#model=${record._model}&id=${record.id}&view_type=form`;
    console.log('Opening URL:', recordUrl);
    console.log('URL parts:', { baseUrl: record._odooUrl, model: record._model, recordId: record.id });
    window.open(recordUrl, '_blank');
  };

  const handleViewChange = (view) => {
    fetchRecordsForView(view);
  };

  const getTaskUserNames = (userIds, userMap) => {
    if (!userIds || userIds.length === 0) return '-';
    return userIds.map(u => {
      const userId = Array.isArray(u) ? u[0] : u;
      const userName = Array.isArray(u) ? u[1] : userMap?.[userId];
      if (userName) return userName;
      // If no name found, log it for debugging
      console.warn(`User ID ${userId} not found in map:`, userMap);
      return `User #${userId}`;
    }).join(', ');
  };

  const getValue = (record, field) => {
    const val = record[field];
    if (Array.isArray(val)) return val[1];
    if (field === 'active') return val !== false ? '✓ Active' : '✗ Inactive';
    return val || '-';
  };

  const renderColumnHeader = (colKey) => {
    const colConfig = COLUMN_CONFIG[activeView]?.find(c => c.key === colKey);
    return colConfig ? colConfig.label : colKey;
  };

  const renderCellValue = (record, colKey) => {
    if (colKey === 'instance') {
      return <strong>{record._instance}</strong>;
    } else if (colKey === 'user_ids') {
      return getTaskUserNames(record.user_ids, record._userMap);
    } else if (colKey === 'user_id' || colKey === 'stage_id' || colKey === 'partner_id' || colKey === 'project_id' || colKey === 'team_id') {
      return getValue(record, colKey);
    }
    return record[colKey] || '-';
  };

  // Helper function to get plain text values for export (no JSX)
  const getExportValue = (record, colKey) => {
    if (colKey === 'instance') {
      return record._instance;
    } else if (colKey === 'user_ids') {
      return getTaskUserNames(record.user_ids, record._userMap);
    } else if (colKey === 'active') {
      return getValue(record, colKey);
    } else if (colKey === 'user_id' || colKey === 'stage_id' || colKey === 'partner_id' || colKey === 'project_id' || colKey === 'team_id') {
      return getValue(record, colKey);
    }
    return record[colKey] || '-';
  };

  const toggleGroup = (key) => {
    setExpandedGroups(prev => ({ ...prev, [key]: !prev[key] }));
  };

  // Prepare pie chart data based on selected column
  const getPieChartData = () => {
    if (!pieChartColumn || !filtered.length) return [];
    
    const dataMap = {};
    const COLORS = [
      '#3b82f6', '#ef4444', '#10b981', '#f59e0b', '#8b5cf6', '#ec4899', '#14b8a6',
      '#f97316', '#06b6d4', '#6366f1', '#84cc16', '#d946ef', '#0ea5e9', '#f43f5e'
    ];
    
    filtered.forEach(rec => {
      let key = 'Unassigned';
      
      if (pieChartColumn === 'instance') {
        key = rec._instance;
      } else if (pieChartColumn === 'user_id') {
        if (rec.user_id) {
          key = Array.isArray(rec.user_id) ? rec.user_id[1] : rec.user_id;
        }
      } else if (pieChartColumn === 'user_ids') {
        if (rec.user_ids && rec.user_ids.length > 0) {
          const firstUser = rec.user_ids[0];
          const userId = Array.isArray(firstUser) ? firstUser[0] : firstUser;
          const userName = Array.isArray(firstUser) ? firstUser[1] : rec._userMap?.[userId];
          key = userName || `User #${userId}`;
        }
      } else if (pieChartColumn === 'stage_id') {
        if (rec.stage_id) {
          key = Array.isArray(rec.stage_id) ? rec.stage_id[1] : rec.stage_id;
        }
      } else if (pieChartColumn === 'partner_id') {
        if (rec.partner_id) {
          key = Array.isArray(rec.partner_id) ? rec.partner_id[1] : rec.partner_id;
        }
      } else if (pieChartColumn === 'project_id') {
        if (rec.project_id) {
          key = Array.isArray(rec.project_id) ? rec.project_id[1] : rec.project_id;
        }
      } else if (pieChartColumn === 'team_id') {
        if (rec.team_id) {
          key = Array.isArray(rec.team_id) ? rec.team_id[1] : rec.team_id;
        }
      } else if (pieChartColumn === 'active') {
        key = getValue(rec, 'active');
      } else if (pieChartColumn === 'priority') {
        key = rec.priority || 'No Priority';
      } else {
        key = rec[pieChartColumn] || 'Unknown';
      }
      
      dataMap[key] = (dataMap[key] || 0) + 1;
    });
    
    return Object.entries(dataMap)
      .map((entry, idx) => ({
        name: entry[0],
        value: entry[1],
        color: COLORS[idx % COLORS.length]
      }))
      .sort((a, b) => b.value - a.value);
  };

  // Export data to Excel
  const exportToExcel = () => {
    if (!filtered.length) {
      alert('No data to export');
      return;
    }

    const exportColumns = getImportantColumns();
    const exportData = filtered.map(rec => {
      const row = {};
      exportColumns.forEach(colKey => {
        const label = renderColumnHeader(colKey);
        const value = getExportValue(rec, colKey);
        row[label] = value;
      });
      return row;
    });

    const worksheet = XLSX.utils.json_to_sheet(exportData);
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, worksheet, activeView);
    
    // Create header style with proper XLSX formatting
    const headerStyle = {
      font: { bold: true, color: { rgb: 'FFFFFF' }, size: 12 },
      fill: { patternType: 'solid', fgColor: { rgb: '2563EB' } },
      alignment: { horizontal: 'center', vertical: 'center', wrapText: true },
      border: {
        top: { style: 'thin', color: { rgb: '1E40AF' } },
        bottom: { style: 'thin', color: { rgb: '1E40AF' } },
        left: { style: 'thin', color: { rgb: '1E40AF' } },
        right: { style: 'thin', color: { rgb: '1E40AF' } }
      }
    };

    // Apply styles to header row - get number of columns
    const numCols = exportColumns.length;
    for (let i = 0; i < numCols; i++) {
      const cellRef = XLSX.utils.encode_col(i) + '1';
      if (!worksheet[cellRef]) {
        worksheet[cellRef] = { t: 's', v: '' };
      }
      worksheet[cellRef].s = headerStyle;
    }

    // Add autofilter to headers
    const endCol = XLSX.utils.encode_col(numCols - 1);
    worksheet['!autofilter'] = { ref: `A1:${endCol}${exportData.length + 1}` };

    // Create style for data rows - light blue background with dark text
    const rowStyle = {
      font: { color: { rgb: '1E40AF' }, size: 11 },
      fill: { patternType: 'solid', fgColor: { rgb: 'DBEAFE' } },
      alignment: { horizontal: 'left', vertical: 'center', wrapText: true },
      border: {
        top: { style: 'thin', color: { rgb: 'E0E7FF' } },
        bottom: { style: 'thin', color: { rgb: 'E0E7FF' } },
        left: { style: 'thin', color: { rgb: 'E0E7FF' } },
        right: { style: 'thin', color: { rgb: 'E0E7FF' } }
      }
    };

    // Apply row styles to all data rows
    for (let row = 2; row <= exportData.length + 1; row++) {
      for (let col = 0; col < numCols; col++) {
        const cellRef = XLSX.utils.encode_col(col) + row;
        if (!worksheet[cellRef]) {
          worksheet[cellRef] = { t: 's', v: '' };
        }
        worksheet[cellRef].s = rowStyle;
      }
    }

    // Auto-size columns - calculate based on both header and data
    const maxWidth = 50;
    const colWidths = exportColumns.map(colKey => {
      const header = renderColumnHeader(colKey);
      let maxLength = header.length;
      
      // Check all data rows to find the longest content
      exportData.forEach(row => {
        const cellValue = row[header];
        if (cellValue) {
          const cellLength = String(cellValue).length;
          if (cellLength > maxLength) {
            maxLength = cellLength;
          }
        }
      });
      
      return Math.min(maxWidth, Math.max(15, maxLength + 3));
    });
    worksheet['!cols'] = colWidths.map(width => ({ wch: width }));

    // Freeze first row (header)
    worksheet['!freeze'] = { xSplit: 0, ySplit: 1 };

    const fileName = `${activeView}_${new Date().toISOString().slice(0, 10)}.xlsx`;
    XLSX.writeFile(workbook, fileName);
  };

  // Filter records based on instance and status/assigned to/salesperson
  let filtered = records.filter(r => {
    if (selectedInstance !== 'all' && r._instance !== selectedInstance) return false;
    if (activeView === 'contacts' || activeView === 'companies') {
      if (statusFilter === 'active' && r.active === false) return false;
      if (statusFilter === 'inactive' && r.active !== false) return false;
      if (salespersonFilter !== 'all') {
        const sp = Array.isArray(r.user_id) ? r.user_id[1] : r.user_id;
        if (sp !== salespersonFilter) return false;
      }
    } else if (activeView === 'helpdesk') {
      if (assignedToFilter !== 'all') {
        const assignedTo = Array.isArray(r.user_id) ? r.user_id[1] : r.user_id;
        if (assignedTo !== assignedToFilter) return false;
      }
      // Filter by status
      if (helpdeskStatusFilter !== 'all') {
        const stageValue = Array.isArray(r.stage_id) ? r.stage_id[1] : r.stage_id;
        const stageName = stageValue ? stageValue.toLowerCase() : '';
        if (helpdeskStatusFilter === 'solved' && !stageName.includes('solved')) return false;
        if (helpdeskStatusFilter === 'cancelled' && !stageName.includes('cancelled')) return false;
        if (helpdeskStatusFilter === 'open' && (stageName.includes('solved') || stageName.includes('cancelled'))) return false;
      }
    } else if (activeView === 'tasks') {
      // Filter tasks by status
      if (taskStatusFilter !== 'all') {
        const stageValue = Array.isArray(r.stage_id) ? r.stage_id[1] : r.stage_id;
        const stageName = stageValue ? stageValue.toLowerCase() : '';
        if (taskStatusFilter === 'completed' && !stageName.includes('completed')) return false;
        if (taskStatusFilter === 'open' && stageName.includes('completed')) return false;
      }
    }
    return true;
  });

  // Sort records
  filtered = [...filtered].sort((a, b) => {
    let aVal = sortBy === 'name' ? a.name : (a.date_deadline || a.create_date || '');
    let bVal = sortBy === 'name' ? b.name : (b.date_deadline || b.create_date || '');
    if (typeof aVal === 'string') aVal = aVal.toLowerCase();
    if (typeof bVal === 'string') bVal = bVal.toLowerCase();
    const cmp = aVal < bVal ? -1 : aVal > bVal ? 1 : 0;
    return sortOrder === 'asc' ? cmp : -cmp;
  });

  // Get unique assigned to and salesperson values
  const uniqueAssignedTo = [...new Set(filtered.filter(r => r.user_id).map(r => Array.isArray(r.user_id) ? r.user_id[1] : r.user_id))].sort();
  const uniqueSalesperson = [...new Set(filtered.filter(r => r.user_id).map(r => Array.isArray(r.user_id) ? r.user_id[1] : r.user_id))].sort();

  // Get unique instances from records
  const instances = [...new Set(records.map(r => r._instance))].sort();

  // Helper function to count helpdesk tickets by status
  const getHelpdeskStatusCounts = () => {
    const allRecordsForInstance = records.filter(r => selectedInstance === 'all' || r._instance === selectedInstance);
    const solved = allRecordsForInstance.filter(r => {
      const stageValue = Array.isArray(r.stage_id) ? r.stage_id[1] : r.stage_id;
      return stageValue && stageValue.toLowerCase().includes('solved');
    }).length;
    const cancelled = allRecordsForInstance.filter(r => {
      const stageValue = Array.isArray(r.stage_id) ? r.stage_id[1] : r.stage_id;
      return stageValue && stageValue.toLowerCase().includes('cancelled');
    }).length;
    const open = allRecordsForInstance.filter(r => {
      const stageValue = Array.isArray(r.stage_id) ? r.stage_id[1] : r.stage_id;
      const stageName = stageValue ? stageValue.toLowerCase() : '';
      return !stageName.includes('solved') && !stageName.includes('cancelled');
    }).length;
    return { solved, cancelled, open };
  };

  const getTaskStatusCounts = () => {
    const allRecordsForInstance = records.filter(r => selectedInstance === 'all' || r._instance === selectedInstance);
    const completed = allRecordsForInstance.filter(r => {
      const stageValue = Array.isArray(r.stage_id) ? r.stage_id[1] : r.stage_id;
      return stageValue && (stageValue.toLowerCase().includes('completed') || stageValue.toLowerCase().includes('completed / on prod'));
    }).length;
    const open = allRecordsForInstance.filter(r => {
      const stageValue = Array.isArray(r.stage_id) ? r.stage_id[1] : r.stage_id;
      const stageName = stageValue ? stageValue.toLowerCase() : '';
      return !stageName.includes('completed');
    }).length;
    return { completed, open };
  };

  // Apply grouping if selected
  let grouped = null;
  let displayRecords = filtered;
  if (groupBy) {
    grouped = {};
    console.log(`Grouping by "${groupBy}" for ${activeView}:`, filtered.length, 'records');
    filtered.forEach(rec => {
      let groupKey = 'Unassigned';
      
      if (groupBy === 'instance') {
        groupKey = rec._instance;
      } else if (groupBy === 'user_id') {
        // For contacts, companies, helpdesk
        if (rec.user_id) {
          groupKey = Array.isArray(rec.user_id) ? rec.user_id[1] : rec.user_id;
        }
      } else if (groupBy === 'user_ids') {
        // For tasks
        if (rec.user_ids && rec.user_ids.length > 0) {
          const firstUser = rec.user_ids[0];
          const userId = Array.isArray(firstUser) ? firstUser[0] : firstUser;
          const userName = Array.isArray(firstUser) ? firstUser[1] : rec._userMap?.[userId];
          groupKey = userName || `User #${userId}`;
        }
      } else if (groupBy === 'stage_id') {
        if (rec.stage_id) {
          groupKey = Array.isArray(rec.stage_id) ? rec.stage_id[1] : rec.stage_id;
        }
      } else if (groupBy === 'partner_id') {
        if (rec.partner_id) {
          groupKey = Array.isArray(rec.partner_id) ? rec.partner_id[1] : rec.partner_id;
        }
      } else if (groupBy === 'project_id') {
        if (rec.project_id) {
          groupKey = Array.isArray(rec.project_id) ? rec.project_id[1] : rec.project_id;
        }
      } else if (groupBy === 'team_id') {
        if (rec.team_id) {
          groupKey = Array.isArray(rec.team_id) ? rec.team_id[1] : rec.team_id;
        }
      } else if (groupBy === 'name') {
        groupKey = rec.name;
      } else if (groupBy === 'create_date') {
        groupKey = rec.create_date || 'No Date';
      } else if (groupBy === 'active') {
        groupKey = getValue(rec, 'active');
      } else if (groupBy === 'date_deadline') {
        groupKey = rec.date_deadline || 'No Deadline';
      } else if (groupBy === 'priority') {
        groupKey = rec.priority || 'No Priority';
      } else if (groupBy === 'email') {
        groupKey = rec.email || 'No Email';
      }
      
      if (!grouped[groupKey]) grouped[groupKey] = [];
      grouped[groupKey].push(rec);
    });
    console.log(`Grouped results:`, Object.keys(grouped), grouped);
  }

  // Pagination logic
  const totalPages = Math.ceil(displayRecords.length / pageSize);
  const startIdx = (currentPage - 1) * pageSize;
  const endIdx = startIdx + pageSize;
  const paginatedRecords = displayRecords.slice(startIdx, endIdx);

  return (
    <div className="dashboard-container">
      <div className="dashboard-header">
        <h1>Odoo Consolidated Dashboard</h1>
        <div style={{ display: 'flex', gap: '10px' }}>
          <button className="logout-btn" onClick={exportToExcel} style={{ background: '#10b981' }}>
            📥 Export Excel
          </button>
          <button className="logout-btn" onClick={() => {
            setShowPieChart(true);
            setPieChartColumn(getGroupableColumns()[0]?.key || null);
          }} style={{ background: '#8b5cf6' }}>
            📊 Pie Chart
          </button>
          <button className="logout-btn" onClick={() => setShowColumnSelector(!showColumnSelector)}>
            ⚙ Columns
          </button>
          <button className="logout-btn" onClick={onLogout}>Logout from All</button>
        </div>
      </div>

      {showPieChart && (
        <div className="pie-chart-modal">
          <div className="pie-chart-content">
            <div className="pie-chart-header">
              <h3>Data Visualization - {activeView.charAt(0).toUpperCase() + activeView.slice(1)}</h3>
              <button className="pie-chart-close-btn" onClick={() => setShowPieChart(false)}>✕</button>
            </div>

            <div className="pie-chart-selector">
              <label htmlFor="pie-chart-column">Group By:</label>
              <select
                id="pie-chart-column"
                className="filter-select"
                value={pieChartColumn || ''}
                onChange={(e) => setPieChartColumn(e.target.value || null)}
              >
                <option value="">Select a column...</option>
                {selectedColumns[activeView].includes('instance') && <option value="instance">Instance</option>}
                {getGroupableColumns().map(col => (
                  <option key={col.key} value={col.key}>
                    {col.label}
                  </option>
                ))}
              </select>
            </div>

            {pieChartColumn && getPieChartData().length > 0 && (
              <div className="pie-chart-wrapper">
                <div className="pie-chart-container">
                  <ResponsiveContainer width="100%" height={420}>
                    <PieChart>
                      <Pie
                        data={getPieChartData()}
                        cx="50%"
                        cy="50%"
                        labelLine={false}
                        outerRadius={110}
                        fill="#8884d8"
                        dataKey="value"
                      >
                        {getPieChartData().map((entry, index) => (
                          <Cell key={`cell-${index}`} fill={entry.color} />
                        ))}
                      </Pie>
                      <Tooltip 
                        formatter={(value) => `${value} records`}
                        contentStyle={{
                          backgroundColor: '#fff',
                          border: '1px solid #e5e7eb',
                          borderRadius: '8px',
                          boxShadow: '0 4px 12px rgba(0,0,0,0.1)'
                        }}
                      />
                    </PieChart>
                  </ResponsiveContainer>
                </div>
                <div className="pie-chart-legend">
                  <h4>Summary</h4>
                  <div className="legend-items">
                    {getPieChartData().map((item, idx) => (
                      <div key={idx} className="legend-item">
                        <span className="legend-color" style={{ backgroundColor: item.color }}></span>
                        <span className="legend-label">{item.name}</span>
                        <span className="legend-value">{item.value}</span>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            )}

            {(!pieChartColumn || getPieChartData().length === 0) && (
              <div className="pie-chart-empty">
                <p>Select a column to visualize data</p>
              </div>
            )}

            <button className="pie-chart-done-btn" onClick={() => setShowPieChart(false)}>
              Done
            </button>
          </div>
        </div>
      )}

      {showColumnSelector && (
        <div className="column-selector-modal">
          <div className="column-selector-content">
            <h3>Select Columns to Display</h3>
            <p className="column-selector-subtitle">Choose important columns to display in the list view</p>
            <div className="column-selector-grid">
              {COLUMN_CONFIG[activeView]?.filter(col => col.important && !col.exclude).map(col => (
                <label key={col.key} className={`column-checkbox ${col.important ? 'important' : ''}`}>
                  <input
                    type="checkbox"
                    checked={selectedColumns[activeView].includes(col.key)}
                    onChange={() => toggleColumn(col.key)}
                  />
                  <span>
                    {col.label}
                    {col.important && <span className="important-badge">⭐ Important</span>}
                  </span>
                </label>
              ))}
            </div>
            <button className="column-selector-close" onClick={() => setShowColumnSelector(false)}>
              Done
            </button>
          </div>
        </div>
      )}

      <div className="view-controls">
        {/* <button className={`view-btn ${activeView === 'contacts' ? 'active' : ''}`} onClick={() => handleViewChange('contacts')}>
          Contacts
        </button>
        <button className={`view-btn ${activeView === 'companies' ? 'active' : ''}`} onClick={() => handleViewChange('companies')}>
          Companies
        </button> */}
       
        <button className={`view-btn ${activeView === 'helpdesk' ? 'active' : ''}`} onClick={() => handleViewChange('helpdesk')}>
          Helpdesk
        </button>
         <button className={`view-btn ${activeView === 'tasks' ? 'active' : ''}`} onClick={() => handleViewChange('tasks')}>
          Tasks
        </button>
      </div>

      <div className="filter-controls">
        <div className="filter-row">
          <label htmlFor="instance-filter">Filter by Instance:</label>
          <select 
            id="instance-filter"
            className="filter-select"
            value={selectedInstance} 
            onChange={(e) => {
              setSelectedInstance(e.target.value);
              setCurrentPage(1);
            }}
          >
            <option value="all">All Instances</option>
            {instances.map(inst => (
              <option key={inst} value={inst}>{inst}</option>
            ))}
          </select>

          {(activeView === 'contacts' || activeView === 'companies') && (
            <>
              <label htmlFor="status-filter">Status:</label>
              <select
                id="status-filter"
                className="filter-select"
                value={statusFilter}
                onChange={(e) => {
                  setStatusFilter(e.target.value);
                  setCurrentPage(1);
                }}
              >
                <option value="all">All {activeView === 'contacts' ? 'Contacts' : 'Companies'}</option>
                <option value="active">Active Only</option>
                <option value="inactive">Inactive Only</option>
              </select>

              <label htmlFor="salesperson-filter">{activeView === 'contacts' ? 'Sales Person' : 'Account Manager'}:</label>
              <select
                id="salesperson-filter"
                className="filter-select"
                value={salespersonFilter}
                onChange={(e) => {
                  setSalespersonFilter(e.target.value);
                  setCurrentPage(1);
                }}
              >
                <option value="all">All {activeView === 'contacts' ? 'Sales Persons' : 'Account Managers'}</option>
                {uniqueSalesperson.map(sp => (
                  <option key={sp} value={sp}>{sp}</option>
                ))}
              </select>
            </>
          )}

          {activeView === 'helpdesk' && (
            <>
              <label htmlFor="assigned-to-filter">Assigned To:</label>
              <select
                id="assigned-to-filter"
                className="filter-select"
                value={assignedToFilter}
                onChange={(e) => {
                  setAssignedToFilter(e.target.value);
                  setCurrentPage(1);
                }}
              >
                <option value="all">All Assignees</option>
                {uniqueAssignedTo.map(at => (
                  <option key={at} value={at}>{at}</option>
                ))}
              </select>
            </>
          )}
        </div>

        {activeView === 'helpdesk' && (
          <div className="helpdesk-status-buttons">
            <button
              className={`status-card-btn ${helpdeskStatusFilter === 'solved' ? 'active' : ''}`}
              onClick={() => {
                setHelpdeskStatusFilter('solved');
                setCurrentPage(1);
              }}
            >
              <span className="status-icon">✓</span>
              <span className="status-label">Solved</span>
              <span className="status-count">{getHelpdeskStatusCounts().solved}</span>
            </button>
            <button
              className={`status-card-btn ${helpdeskStatusFilter === 'cancelled' ? 'active' : ''}`}
              onClick={() => {
                setHelpdeskStatusFilter('cancelled');
                setCurrentPage(1);
              }}
            >
              <span className="status-icon">✕</span>
              <span className="status-label">Cancelled</span>
              <span className="status-count">{getHelpdeskStatusCounts().cancelled}</span>
            </button>
            <button
              className={`status-card-btn ${helpdeskStatusFilter === 'open' ? 'active' : ''}`}
              onClick={() => {
                setHelpdeskStatusFilter('open');
                setCurrentPage(1);
              }}
            >
              <span className="status-icon">◐</span>
              <span className="status-label">Open / Pending</span>
              <span className="status-count">{getHelpdeskStatusCounts().open}</span>
            </button>
            <button
              className={`status-card-btn ${helpdeskStatusFilter === 'all' ? 'active' : ''}`}
              onClick={() => {
                setHelpdeskStatusFilter('all');
                setCurrentPage(1);
              }}
            >
              <span className="status-icon">≡</span>
              <span className="status-label">All Tickets</span>
              <span className="status-count">{getHelpdeskStatusCounts().solved + getHelpdeskStatusCounts().cancelled + getHelpdeskStatusCounts().open}</span>
            </button>
          </div>
        )}

        {activeView === 'tasks' && (
          <div className="helpdesk-status-buttons">
            <button
              className={`status-card-btn ${taskStatusFilter === 'completed' ? 'active' : ''}`}
              onClick={() => {
                setTaskStatusFilter('completed');
                setCurrentPage(1);
              }}
            >
              <span className="status-icon">✓</span>
              <span className="status-label">Completed</span>
              <span className="status-count">{getTaskStatusCounts().completed}</span>
            </button>
            <button
              className={`status-card-btn ${taskStatusFilter === 'open' ? 'active' : ''}`}
              onClick={() => {
                setTaskStatusFilter('open');
                setCurrentPage(1);
              }}
            >
              <span className="status-icon">◐</span>
              <span className="status-label">Open / Pending</span>
              <span className="status-count">{getTaskStatusCounts().open}</span>
            </button>
            <button
              className={`status-card-btn ${taskStatusFilter === 'all' ? 'active' : ''}`}
              onClick={() => {
                setTaskStatusFilter('all');
                setCurrentPage(1);
              }}
            >
              <span className="status-icon">≡</span>
              <span className="status-label">All Tasks</span>
              <span className="status-count">{getTaskStatusCounts().completed + getTaskStatusCounts().open}</span>
            </button>
          </div>
        )}

        <div className="sort-group-row">
          <label htmlFor="sort-by">Sort by:</label>
          <select
            id="sort-by"
            className="filter-select"
            value={sortBy}
            onChange={(e) => setSortBy(e.target.value)}
          >
            <option value="name">Name</option>
            <option value="date">Date</option>
          </select>

          <select
            className="filter-select"
            value={sortOrder}
            onChange={(e) => setSortOrder(e.target.value)}
          >
            <option value="asc">↑ Ascending</option>
            <option value="desc">↓ Descending</option>
          </select>

          <label htmlFor="group-by">Group by:</label>
          <select
            id="group-by"
            className="filter-select"
            value={groupBy || ''}
            onChange={(e) => {
              const newValue = e.target.value || null;
              setGroupBy(newValue);
              setExpandedGroups({});
              setCurrentPage(1);
            }}
          >
            <option value="">No Grouping</option>
            {selectedColumns[activeView].includes('instance') && <option value="instance">Instance</option>}
            {getGroupableColumns().map(col => (
              <option key={col.key} value={col.key}>
                {col.label}
              </option>
            ))}
          </select>

          <span className="record-count">
            Showing {groupBy ? Object.values(grouped || {}).reduce((sum, g) => sum + g.length, 0) : filtered.length} records
          </span>
        </div>
      </div>

      {loading && <p className="loading">Loading records...</p>}
      {error && <p className="error">{error}</p>}

      {filtered.length > 0 && (
        <div className="records-container">
          {!groupBy ? (
            <>
              <table className="records-table">
                <thead>
                  <tr>
                    {selectedColumns[activeView].map(colKey => (
                      <th key={colKey} className={colKey === 'instance' ? 'instance-cell' : ''}>
                        {renderColumnHeader(colKey)}
                      </th>
                    ))}
                    <th>Action</th>
                  </tr>
                </thead>
                <tbody>
                  {paginatedRecords.map((rec, idx) => (
                    <tr key={`${rec._instance}-${rec.id}-${idx}`}>
                      {selectedColumns[activeView].map(colKey => (
                        <td key={colKey} className={colKey === 'instance' ? 'instance-cell' : ''}>
                          {renderCellValue(rec, colKey)}
                        </td>
                      ))}
                      <td>
                        <button className="open-btn" onClick={() => openRecordInOdoo(rec)}>
                          Open
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>

              <div className="pagination-controls">
                <button 
                  className="pagination-btn"
                  onClick={() => setCurrentPage(1)} 
                  disabled={currentPage === 1}
                >
                  First
                </button>
                <button 
                  className="pagination-btn"
                  onClick={() => setCurrentPage(prev => Math.max(1, prev - 1))} 
                  disabled={currentPage === 1}
                >
                  Previous
                </button>
                <span className="page-info">
                  Page {currentPage} of {totalPages}
                </span>
                <button 
                  className="pagination-btn"
                  onClick={() => setCurrentPage(prev => Math.min(totalPages, prev + 1))} 
                  disabled={currentPage === totalPages}
                >
                  Next
                </button>
                <button 
                  className="pagination-btn"
                  onClick={() => setCurrentPage(totalPages)} 
                  disabled={currentPage === totalPages}
                >
                  Last
                </button>
              </div>
            </>
          ) : (
            <div className="grouped-view">
              {grouped && Object.entries(grouped).map(([groupKey, groupRecs]) => (
                <div key={groupKey} className="group-section">
                  <button 
                    className="group-header-btn"
                    onClick={() => toggleGroup(groupKey)}
                  >
                    <span className="expand-icon">{expandedGroups[groupKey] ? '▼' : '▶'}</span>
                    <span className="group-title">{groupKey}</span>
                    <span className="group-count">({groupRecs.length})</span>
                  </button>
                  {expandedGroups[groupKey] && (
                    <table className="records-table">
                      <thead>
                        <tr>
                          {selectedColumns[activeView].map(colKey => (
                            <th key={colKey} className={colKey === 'instance' ? 'instance-cell' : ''}>
                              {renderColumnHeader(colKey)}
                            </th>
                          ))}
                          <th>Action</th>
                        </tr>
                      </thead>
                      <tbody>
                        {groupRecs.map((rec, idx) => (
                          <tr key={`${rec._instance}-${rec.id}-${idx}`}>
                            {selectedColumns[activeView].map(colKey => (
                              <td key={colKey} className={colKey === 'instance' ? 'instance-cell' : ''}>
                                {renderCellValue(rec, colKey)}
                              </td>
                            ))}
                            <td>
                              <button className="open-btn" onClick={() => openRecordInOdoo(rec)}>
                                Open
                              </button>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {filtered.length === 0 && !loading && !error && (
        <p className="no-records">No records found. Select a view to see data.</p>
      )}
    </div>
  );
}

function App() {
  const [authenticatedInstances, setAuthenticatedInstances] = useState(null);

  const handleAllAuthenticated = (instances) => {
    setAuthenticatedInstances(instances);
  };

  const handleLogout = () => {
    setAuthenticatedInstances(null);
  };

  return (
    <div className="app">
      {!authenticatedInstances ? (
        <LoginFlow onAllAuthenticated={handleAllAuthenticated} />
      ) : (
        <ConsolidatedDashboard authenticatedInstances={authenticatedInstances} onLogout={handleLogout} />
      )}
    </div>
  );
}

export default App;
