import { useState, useEffect } from 'react';
import { PieChart, Pie, Cell, Tooltip, ResponsiveContainer } from 'recharts';
import * as XLSX from 'xlsx';
import { ODOO_CONFIG, findOdooConfig } from './OdooClasses.js';
import { OdooInstance, OdooAPIClient, RecordFilter } from './OdooClasses.js';
import './style.css';

// Host that fronts the per-instance transparent Odoo reverse proxy (see server.js).
// "Open" navigates to  <proto>//<dbName>.<ODOO_PROXY_DOMAIN>/web#...  and the proxy
// forwards to that Odoo instance with the server-side session injected -> no re-login.
//   Dev:  '<db>.localhost:5174' resolves to loopback automatically in Chrome/Edge.
//   Prod: point each '<db>' (or '<db>-proxy') subdomain at the proxy via DNS + IIS,
//         and set VITE_ODOO_PROXY_DOMAIN at build time.
const ODOO_PROXY_DOMAIN = import.meta.env.VITE_ODOO_PROXY_DOMAIN || 'localhost:5174';

// Column configuration for different views
const COLUMN_CONFIG = {
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

function LoginFlow({ onAllAuthenticated }) {
  const [url, setUrl] = useState('');
  const [loading, setLoading] = useState(false);
  const [addConnectionError, setAddConnectionError] = useState('');
  const [errors, setErrors] = useState({}); // Store errors per connection ID
  const [credentials, setCredentials] = useState({}); // Store credentials per connection ID
  const [savedConnections, setSavedConnections] = useState([]);
  const [authenticatedConnections, setAuthenticatedConnections] = useState({});

  // Load saved connections on mount
  useEffect(() => {
    const loadConnections = async () => {
      try {
        const apiUrl = '/api/connections';
        console.log('[loadConnections] Fetching from:', apiUrl);
        const response = await fetch(apiUrl);
        if (!response.ok) {
          throw new Error(`HTTP ${response.status}: ${response.statusText}`);
        }
        const text = await response.text();
        if (!text) {
          console.warn('Empty response from /api/connections');
          setSavedConnections([]);
          return;
        }
        const connections = JSON.parse(text);
        setSavedConnections(connections);
      } catch (err) {
        console.error('Failed to load connections:', err);
        setSavedConnections([]);
      }
    };
    loadConnections();
  }, []);

  const handleAddConnection = async () => {
    setAddConnectionError('');
    
    if (!url.trim()) {
      setAddConnectionError('Please enter an Odoo URL');
      return;
    }

    const config = findOdooConfig(url);
    if (!config) {
      setAddConnectionError('This Odoo URL is not allowed to be added.');
      return;
    }

    try {
      setLoading(true);

      // Check if connection already exists
      if (savedConnections.some(c => c.url === config.url)) {
        setAddConnectionError('This connection is already saved');
        return;
      }

      // Save connection to backend
      console.log('[handleAddConnection] Sending request:', { url: config.url, label: config.label, dbName: config.dbName });
      const response = await fetch('/api/connections', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          url: config.url,
          label: config.label,
          dbName: config.dbName
        })
      });

      console.log('[handleAddConnection] Response status:', response.status, response.statusText);

      if (!response.ok) {
        const text = await response.text();
        console.error('[handleAddConnection] Error response:', text);
        let errorMsg = `Server error (${response.status}): Failed to save connection`;
        try {
          const err = JSON.parse(text);
          errorMsg = err.error || errorMsg;
        } catch (e) {
          errorMsg = text || errorMsg;
        }
        console.error('[handleAddConnection] Throwing error:', errorMsg);
        throw new Error(errorMsg);
      }

      const text = await response.text();
      console.log('[handleAddConnection] Success response:', text.substring(0, 200));
      if (!text) {
        throw new Error('Empty response from server');
      }
      const newConnection = JSON.parse(text);
      setSavedConnections([...savedConnections, newConnection]);
      setUrl('');
      setAddConnectionError('');
    } catch (err) {
      setAddConnectionError(err.message || 'Failed to add connection');
    } finally {
      setLoading(false);
    }
  };

  const handleAuthenticateConnection = async (connection) => {
    setErrors({...errors, [connection.id]: ''});

    const connCreds = credentials[connection.id] || {};
    if (!connCreds.username?.trim() || !connCreds.password?.trim()) {
      setErrors({...errors, [connection.id]: 'Please enter username and password'});
      return;
    }

    try {
      setLoading(true);
      
      const instance = new OdooInstance(
        connection.id,
        connection.label,
        connection.url,
        connection.dbName,
        `/odoo-proxy/${connection.id}`
      );

      const apiClient = new OdooAPIClient(instance);
      const authResult = await apiClient.authenticate(connCreds.username, connCreds.password);

      // Store authenticated connection with email from auth response or apiClient
      const userEmail = authResult?.user?.email || apiClient.getCurrentUserEmail();
      console.log(`✓ Authenticated connection ${connection.label} - user email: ${userEmail}`);

      setAuthenticatedConnections({
        ...authenticatedConnections,
        [connection.id]: {
          instance: instance,
          apiClient: apiClient,
          username: connCreds.username,
          userId: authResult?.user?.id,
          userEmail: userEmail
        }
      });

      // Clear credentials after successful auth
      setCredentials({...credentials, [connection.id]: {username: '', password: ''}});
    } catch (err) {
      setErrors({...errors, [connection.id]: err.message || 'Authentication failed'});
    } finally {
      setLoading(false);
    }
  };

  const handleRemoveConnection = async (connId) => {
    try {
      setLoading(true);
      const response = await fetch(`/api/connections/${connId}`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' }
      });

      if (!response.ok) {
        const text = await response.text();
        let errorMsg = 'Failed to delete connection';
        try {
          const err = JSON.parse(text);
          errorMsg = err.error || errorMsg;
        } catch (e) {
          errorMsg = text || errorMsg;
        }
        throw new Error(errorMsg);
      }

      setSavedConnections(savedConnections.filter(c => c.id !== connId));
      
      // Also remove from authenticated if it was authenticated
      const newAuth = { ...authenticatedConnections };
      delete newAuth[connId];
      setAuthenticatedConnections(newAuth);
    } catch (err) {
      setErrors({...errors, [connId]: err.message || 'Failed to delete connection'});
    } finally {
      setLoading(false);
    }
  };

  const isReadyForDashboard = Object.keys(authenticatedConnections).length > 0;

  return (
    <div className="login-container">
      <div className="login-card">
        <h1>Odoo Multi-Instance Login</h1>

        {/* Add New Connection Section */}
        <div className="login-form">
          <h3>Add New Connection</h3>
          <input
            type="text"
            placeholder="Enter Odoo URL (e.g., https://abc.odoo.com)"
            value={url}
            onChange={(e) => {
              setUrl(e.target.value);
              setAddConnectionError(''); // Clear error when user types
            }}
            disabled={loading}
            className="login-input"
          />
          {addConnectionError && <p className="error">{addConnectionError}</p>}
          <button
            onClick={handleAddConnection}
            disabled={loading || !url.trim()}
            className="login-btn"
          >
            {loading ? 'Adding...' : 'Add Connection'}
          </button>
        </div>

        {/* Connections with Inline Login Forms */}
        {savedConnections.length > 0 && (
          <div className="connections-grid">
            {savedConnections.map((conn) => {
              const isAuthenticated = !!authenticatedConnections[conn.id];

              return (
                <div key={conn.id} className="connection-card">
                  <div className="connection-header">
                    <div>
                      <h4>{conn.label}</h4>
                      <p className="connection-url">{conn.url}</p>
                      {isAuthenticated && (
                        <p className="auth-status">
                          ✓ Authenticated as: <strong>{authenticatedConnections[conn.id].username}</strong>
                        </p>
                      )}
                    </div>
                    <button
                      onClick={() => handleRemoveConnection(conn.id)}
                      className="card-delete-btn"
                      disabled={loading}
                      title="Remove connection"
                    >
                      ✕
                    </button>
                  </div>

                  {!isAuthenticated && (
                    <div className="connection-login-form">
                      <input
                        type="text"
                        placeholder="Username"
                        value={credentials[conn.id]?.username || ''}
                        onChange={(e) => {
                          setCredentials({...credentials, [conn.id]: {...(credentials[conn.id] || {}), username: e.target.value}});
                          setErrors({...errors, [conn.id]: ''});
                        }}
                        disabled={loading}
                        className="login-input-small"
                      />
                      <input
                        type="password"
                        placeholder="Password"
                        value={credentials[conn.id]?.password || ''}
                        onChange={(e) => {
                          setCredentials({...credentials, [conn.id]: {...(credentials[conn.id] || {}), password: e.target.value}});
                          setErrors({...errors, [conn.id]: ''});
                        }}
                        disabled={loading}
                        className="login-input-small"
                      />
                      <button
                        onClick={() => handleAuthenticateConnection(conn)}
                        disabled={loading || !credentials[conn.id]?.username?.trim() || !credentials[conn.id]?.password?.trim()}
                        className="login-btn compact"
                      >
                        {loading ? 'Auth...' : 'Login'}
                      </button>
                      {errors[conn.id] && <p className="error">{errors[conn.id]}</p>}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}

        {/* Proceed to Dashboard */}
        {isReadyForDashboard && (
          <button
            onClick={() => onAllAuthenticated(authenticatedConnections)}
            className="login-btn proceed-btn"
          >
            ✓ Proceed to Dashboard
          </button>
        )}
      </div>
    </div>
  );
}

function ConsolidatedDashboard({ authenticatedConnections, onLogout }) {
  const [activeView, setActiveView] = useState('helpdesk');
  const [records, setRecords] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [currentPage, setCurrentPage] = useState(1);
  const [pageSize] = useState(10);
  const [sortBy, setSortBy] = useState('name');
  const [sortOrder, setSortOrder] = useState('asc');
  const [groupBy, setGroupBy] = useState(null);
  const [expandedGroups, setExpandedGroups] = useState({});
  const [selectedColumns, setSelectedColumns] = useState({
    tasks: COLUMN_CONFIG.tasks.map(c => c.key),
    helpdesk: COLUMN_CONFIG.helpdesk.map(c => c.key),
  });
  const [filters, setFilters] = useState({
    instance: '',
    customer: '',
    createdDateFrom: '',
    createdDateTo: ''
  });

  useEffect(() => {
    if (Object.keys(authenticatedConnections).length > 0) {
      fetchRecordsForView('helpdesk');
    }
  }, []);

  const fetchRecordsForView = async (view) => {
    setError('');
    setLoading(true);
    setRecords([]);
    setCurrentPage(1);
    setGroupBy(null);
    setExpandedGroups({});
    setFilters({instance: '', customer: '', createdDateFrom: '', createdDateTo: ''});

    try {
      const model = view === 'helpdesk' ? 'helpdesk.ticket' : 'project.task';
      const fields = view === 'helpdesk'
        ? ['name', 'create_date', 'partner_id', 'team_id', 'user_id', 'stage_id', 'priority']
        : ['name', 'user_ids', 'date_deadline', 'create_date', 'stage_id', 'priority', 'partner_id', 'project_id'];

      let allRecords = [];

      for (const [connId, connData] of Object.entries(authenticatedConnections)) {
        const apiClient = connData.apiClient;
        
        try {
          console.log(`\n=== Processing ${connData.instance.label} ===`);
          console.log(`1️⃣  Fetching user data for email mapping...`);
          
          // Fetch user map for this instance
          await apiClient.fetchUserMap();
          connData.instance.userMap = apiClient.getUserMap();
          
          console.log(`2️⃣  Fetching ${model} records...`);

          // Fetch records
          const recordsData = await apiClient.fetchRecords(model, fields, []);
          console.log(`   Received ${recordsData.length} total records from ${connData.instance.label}`);
          
          if (recordsData.length > 0) {
            console.log(`3️⃣  Filtering records by logged-in user email: ${connData.userEmail}`);
            
            // Filter by logged-in user email
            let filteredRecords = recordsData;
            const userEmailMap = apiClient.getUserEmailMap();
            const userEmail = connData.userEmail;

            if (view === 'tasks') {
              filteredRecords = RecordFilter.filterTasksByAssignedUserEmail(recordsData, userEmail, userEmailMap);
            } else {
              filteredRecords = RecordFilter.filterByAssignedUserEmail(recordsData, userEmail, userEmailMap, 'user_id');
            }

            console.log(`4️⃣  Filtering result: ${filteredRecords.length} records matched`);
            
            // FALLBACK: If filtering returns 0 records, show ALL records with logging
            if (filteredRecords.length === 0 && recordsData.length > 0) {
              console.warn(`⚠️  Email-based filter returned 0 results. Showing all ${recordsData.length} records instead.`);
              console.log(`   User email being searched: "${userEmail}"`);
              console.log(`   User email map:`, userEmailMap);
              console.log(`   First record user_id/user_ids:`, 
                view === 'tasks' ? recordsData[0]?.user_ids : recordsData[0]?.user_id);
              filteredRecords = recordsData; // Show all records as fallback
            }

            // Enrich with metadata and add userEmailMap and userMap
            connData.instance.userEmailMap = userEmailMap;
            connData.instance.userMap = apiClient.getUserMap();
            const enrichedRecords = RecordFilter.enrichWithMetadata(filteredRecords, connData.instance, model);
            allRecords = [...allRecords, ...enrichedRecords];
          }
        } catch (err) {
          console.error(`❌ Error fetching from ${connData.instance.label}:`, err);
        }
      }

      console.log(`\n✅ Total records to display: ${allRecords.length}`);
      setRecords(allRecords);
      setActiveView(view);
    } catch (err) {
      setError(err.message || 'Failed to fetch records');
    } finally {
      setLoading(false);
    }
  };

  const openRecordInOdoo = (record) => {
    if (!record._dbName || !record.id) {
      console.error('Missing instance dbName or record ID');
      return;
    }

    // Go through the per-instance proxy host so the server-side session is injected
    // and the native Odoo client opens already authenticated (no second login).
    const proto = window.location.protocol === 'https:' ? 'https:' : 'http:';
    const origin = `${proto}//${record._dbName}.${ODOO_PROXY_DOMAIN}`;
    const recordUrl = `${origin}/web#model=${record._model}&id=${record.id}&view_type=form`;
    console.log('Opening record via proxy:', recordUrl);
    window.open(recordUrl, '_blank');
  };

  const getValue = (record, field) => {
    const val = record[field];
    if (Array.isArray(val)) return val[1] || val[0];
    return val || '-';
  };

  const renderCellValue = (record, colKey) => {
    if (colKey === 'instance') {
      return <strong>{record._instance}</strong>;
    } else if (colKey === 'user_ids') {
      if (!record.user_ids || record.user_ids.length === 0) return '-';
      return record.user_ids.map(u => {
        const userId = Array.isArray(u) ? u[0] : u;
        const userName = record._userMap?.[userId];
        return `${userName || `User #${userId}`}`;
      }).join(', ');
    } else if (colKey === 'user_id') {
      const val = record[colKey];
      if (!val) return '-';
      const userId = Array.isArray(val) ? val[0] : val;
      const userName = record._userMap?.[userId];
      return `${userName || `User #${userId}`}`;
    }
    return getValue(record, colKey);
  };

  const getExportValue = (record, colKey) => {
    if (colKey === 'instance') {
      return record._instance;
    } else if (colKey === 'user_ids') {
      if (!record.user_ids || record.user_ids.length === 0) return '-';
      return record.user_ids.map(u => {
        const userId = Array.isArray(u) ? u[0] : u;
        const userName = record._userMap?.[userId];
        return `${userName || `User #${userId}`}`;
      }).join(', ');
    } else if (colKey === 'user_id') {
      const val = record[colKey];
      if (!val) return '-';
      const userId = Array.isArray(val) ? val[0] : val;
      const userName = record._userMap?.[userId];
      return `${userName || `User #${userId}`}`;
    }
    return getValue(record, colKey);
  };

  const exportToExcel = () => {
    if (!filtered.length) {
      alert('No data to export');
      return;
    }

    const exportColumns = selectedColumns[activeView];
    const exportData = filtered.map(rec => {
      const row = {};
      exportColumns.forEach(colKey => {
        const colConfig = COLUMN_CONFIG[activeView].find(c => c.key === colKey);
        const label = colConfig ? colConfig.label : colKey;
        const value = getExportValue(rec, colKey);
        row[label] = value;
      });
      return row;
    });

    const worksheet = XLSX.utils.json_to_sheet(exportData);
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, worksheet, activeView);

    const headerStyle = {
      font: { bold: true, color: { rgb: 'FFFFFF' }, size: 12 },
      fill: { patternType: 'solid', fgColor: { rgb: '2563EB' } },
      alignment: { horizontal: 'center', vertical: 'center', wrapText: true },
    };

    const numCols = exportColumns.length;
    for (let i = 0; i < numCols; i++) {
      const cellRef = XLSX.utils.encode_col(i) + '1';
      if (!worksheet[cellRef]) {
        worksheet[cellRef] = { t: 's', v: '' };
      }
      worksheet[cellRef].s = headerStyle;
    }

    const endCol = XLSX.utils.encode_col(numCols - 1);
    worksheet['!autofilter'] = { ref: `A1:${endCol}${exportData.length + 1}` };

    const colWidths = exportColumns.map(colKey => {
      const colConfig = COLUMN_CONFIG[activeView].find(c => c.key === colKey);
      const label = colConfig ? colConfig.label : colKey;
      return Math.min(50, Math.max(15, label.length + 3));
    });
    worksheet['!cols'] = colWidths.map(width => ({ wch: width }));
    worksheet['!freeze'] = { xSplit: 0, ySplit: 1 };

    const fileName = `${activeView}_${new Date().toISOString().slice(0, 10)}.xlsx`;
    XLSX.writeFile(workbook, fileName);
  };

  // Apply filters
  let filtered = records.filter(rec => {
    // Filter by instance
    if (filters.instance && rec._instance !== filters.instance) {
      return false;
    }
    // Filter by customer (partner_id)
    if (filters.customer) {
      const partnerVal = rec.partner_id;
      const partnerName = Array.isArray(partnerVal) ? partnerVal[1] : partnerVal;
      if (!partnerName || !partnerName.toLowerCase().includes(filters.customer.toLowerCase())) {
        return false;
      }
    }
    // Filter by created date range
    if (filters.createdDateFrom || filters.createdDateTo) {
      const createdDate = rec.create_date ? new Date(rec.create_date).toISOString().split('T')[0] : null;
      if (filters.createdDateFrom && createdDate < filters.createdDateFrom) {
        return false;
      }
      if (filters.createdDateTo && createdDate > filters.createdDateTo) {
        return false;
      }
    }
    return true;
  });

  filtered = [...filtered].sort((a, b) => {
    let aVal = sortBy === 'name' ? a.name : (a.date_deadline || a.create_date || '');
    let bVal = sortBy === 'name' ? b.name : (b.date_deadline || b.create_date || '');
    if (typeof aVal === 'string') aVal = aVal.toLowerCase();
    if (typeof bVal === 'string') bVal = bVal.toLowerCase();
    const cmp = aVal < bVal ? -1 : aVal > bVal ? 1 : 0;
    return sortOrder === 'asc' ? cmp : -cmp;
  });

  // Get groupable columns for current view
  const groupableColumns = COLUMN_CONFIG[activeView]
    .filter(col => col.groupable)
    .map(col => col.key);

  let grouped = null;
  let displayRecords = filtered;
  if (groupBy) {
    grouped = {};
    filtered.forEach(rec => {
      let groupKey = 'Unassigned';
      
      if (groupBy === 'instance') {
        groupKey = rec._instance;
      } else if (groupBy === 'stage_id') {
        if (rec.stage_id) {
          groupKey = Array.isArray(rec.stage_id) ? rec.stage_id[1] : rec.stage_id;
        }
      } else if (groupBy === 'partner_id') {
        if (rec.partner_id) {
          groupKey = Array.isArray(rec.partner_id) ? rec.partner_id[1] : rec.partner_id;
        }
      } else if (groupBy === 'user_id') {
        if (rec.user_id) {
          const userId = Array.isArray(rec.user_id) ? rec.user_id[0] : rec.user_id;
          groupKey = rec._userMap?.[userId] || `User #${userId}`;
        }
      } else if (groupBy === 'user_ids') {
        if (rec.user_ids && rec.user_ids.length > 0) {
          const userId = Array.isArray(rec.user_ids[0]) ? rec.user_ids[0][0] : rec.user_ids[0];
          groupKey = rec._userMap?.[userId] || `User #${userId}`;
        }
      } else if (groupBy === 'priority') {
        groupKey = rec.priority || 'Unassigned';
      } else if (groupBy === 'project_id') {
        if (rec.project_id) {
          groupKey = Array.isArray(rec.project_id) ? rec.project_id[1] : rec.project_id;
        }
      } else if (groupBy === 'team_id') {
        if (rec.team_id) {
          groupKey = Array.isArray(rec.team_id) ? rec.team_id[1] : rec.team_id;
        }
      }
      
      if (!grouped[groupKey]) grouped[groupKey] = [];
      grouped[groupKey].push(rec);
    });
  }

  const totalPages = Math.ceil(displayRecords.length / pageSize);
  const startIdx = (currentPage - 1) * pageSize;
  const endIdx = startIdx + pageSize;
  const paginatedRecords = displayRecords.slice(startIdx, endIdx);

  return (
    <div className="dashboard-container">
      <div className="dashboard-header">
        <div>
          <h1>My Assigned Records - {activeView.charAt(0).toUpperCase() + activeView.slice(1)}</h1>
          <p style={{ margin: '5px 0', fontSize: '0.9rem', color: '#6b7280' }}>
            Logged in as: {Object.entries(authenticatedConnections).map(([connId, connData]) => (
              <span key={connId} style={{ marginRight: '15px' }}>
                <strong>{connData.userEmail || connData.username}</strong> ({connData.instance.label})
              </span>
            ))}
          </p>
        </div>
        <div style={{ display: 'flex', gap: '10px' }}>
          {/*<button className="logout-btn" onClick={exportToExcel} style={{ background: '#10b981' }}>
            📥 Export Excel
          </button>*/}
          
          <button className="logout-btn" onClick={onLogout}>Logout</button>
        </div>
      </div>

      <div className="view-controls">
        <button
          className={`view-btn ${activeView === 'helpdesk' ? 'active' : ''}`}
          onClick={() => fetchRecordsForView('helpdesk')}
        >
          Helpdesk Tickets
        </button>
        <button
          className={`view-btn ${activeView === 'tasks' ? 'active' : ''}`}
          onClick={() => fetchRecordsForView('tasks')}
        >
          My Tasks
        </button>
      </div>

      <div className="filter-controls">
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
            onChange={(e) => setGroupBy(e.target.value || null)}
          >
            <option value="">No Grouping</option>
            {groupableColumns.map(colKey => {
              const colConfig = COLUMN_CONFIG[activeView].find(c => c.key === colKey);
              return (
                <option key={colKey} value={colKey}>
                  {colConfig ? colConfig.label : colKey}
                </option>
              );
            })}
          </select>

          <span className="record-count">
            Showing {groupBy ? Object.values(grouped || {}).reduce((sum, g) => sum + g.length, 0) : filtered.length} records
          </span>
        </div>

        <div className="filter-row" style={{ marginTop: '10px', display: 'flex', gap: '10px', alignItems: 'center', flexWrap: 'wrap' }}>
          <label htmlFor="filter-instance">Instance:</label>
          <select
            id="filter-instance"
            className="filter-select"
            value={filters.instance}
            onChange={(e) => setFilters({...filters, instance: e.target.value})}
            style={{ maxWidth: '150px' }}
          >
            <option value="">All Instances</option>
            {[...new Set(records.map(r => r._instance))].map(instance => (
              <option key={instance} value={instance}>{instance}</option>
            ))}
          </select>

          <label htmlFor="filter-customer">Customer:</label>
          <input
            id="filter-customer"
            type="text"
            placeholder="Search customer..."
            className="filter-select"
            value={filters.customer}
            onChange={(e) => setFilters({...filters, customer: e.target.value})}
            style={{ maxWidth: '150px' }}
          />

          <label htmlFor="filter-date-from">Created From:</label>
          <input
            id="filter-date-from"
            type="date"
            className="filter-select"
            value={filters.createdDateFrom}
            onChange={(e) => setFilters({...filters, createdDateFrom: e.target.value})}
            style={{ maxWidth: '130px' }}
          />

          <label htmlFor="filter-date-to">To:</label>
          <input
            id="filter-date-to"
            type="date"
            className="filter-select"
            value={filters.createdDateTo}
            onChange={(e) => setFilters({...filters, createdDateTo: e.target.value})}
            style={{ maxWidth: '130px' }}
          />

          {(filters.instance || filters.customer || filters.createdDateFrom || filters.createdDateTo) && (
            <button
              onClick={() => setFilters({instance: '', customer: '', createdDateFrom: '', createdDateTo: ''})}
              style={{ padding: '5px 10px', background: '#ef4444', color: 'white', border: 'none', borderRadius: '4px', cursor: 'pointer' }}
            >
              Clear Filters
            </button>
          )}
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
                    {selectedColumns[activeView].map(colKey => {
                      const colConfig = COLUMN_CONFIG[activeView].find(c => c.key === colKey);
                      return (
                        <th key={colKey}>
                          {colConfig ? colConfig.label : colKey}
                        </th>
                      );
                    })}
                    <th>Action</th>
                  </tr>
                </thead>
                <tbody>
                  {paginatedRecords.map((rec, idx) => (
                    <tr key={`${rec._instance}-${rec.id}-${idx}`}>
                      {selectedColumns[activeView].map(colKey => (
                        <td key={colKey}>{renderCellValue(rec, colKey)}</td>
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
                    onClick={() => setExpandedGroups(prev => ({ ...prev, [groupKey]: !prev[groupKey] }))}
                  >
                    <span className="expand-icon">{expandedGroups[groupKey] ? '▼' : '▶'}</span>
                    <span className="group-title">{groupKey}</span>
                    <span className="group-count">({groupRecs.length})</span>
                  </button>
                  {expandedGroups[groupKey] && (
                    <table className="records-table">
                      <thead>
                        <tr>
                          {selectedColumns[activeView].map(colKey => {
                            const colConfig = COLUMN_CONFIG[activeView].find(c => c.key === colKey);
                            return (
                              <th key={colKey}>
                                {colConfig ? colConfig.label : colKey}
                              </th>
                            );
                          })}
                          <th>Action</th>
                        </tr>
                      </thead>
                      <tbody>
                        {groupRecs.map((rec, idx) => (
                          <tr key={`${rec._instance}-${rec.id}-${idx}`}>
                            {selectedColumns[activeView].map(colKey => (
                              <td key={colKey}>{renderCellValue(rec, colKey)}</td>
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
        <p className="no-records">No records assigned to you.</p>
      )}
    </div>
  );
}

function App() {
  const [authenticated, setAuthenticated] = useState(null);

  const handleLogout = () => {
    setAuthenticated(null);
  };

  if (!authenticated) {
    return <LoginFlow onAllAuthenticated={setAuthenticated} />;
  }

  return <ConsolidatedDashboard authenticatedConnections={authenticated} onLogout={handleLogout} />;
}

export default App;
