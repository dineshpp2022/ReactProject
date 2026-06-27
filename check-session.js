#!/usr/bin/env node

/**
 * Session Status Checker & Debugger
 * Usage: node check-session.js [command] [instanceId]
 * Commands:
 *   status [id]      Check session status (default)
 *   debug [id]       Detailed debug info
 *   clear [id]       Delete session (for testing)
 *   open [id]        Test opening a record
 * Examples:
 *   node check-session.js
 *   node check-session.js status squadsm
 *   node check-session.js debug squadsm
 *   node check-session.js open squadsm 451
 */

const command = process.argv[2] || 'status';
const arg1 = process.argv[3];
const arg2 = process.argv[4];

const baseUrl = 'http://localhost:5174';
const instances = arg1 && arg1 !== 'all' ? [arg1] : ['squadsm', 'squadts', 'squad-atlas'];

async function checkStatus() {
  console.log('\n🔍 Checking session status...\n');
  
  for (const id of instances) {
    try {
      const resp = await fetch(`${baseUrl}/api/session/status/${id}`);
      const data = await resp.json();
      
      const statusEmoji = data.status === 'active' ? '✅' : data.status === 'no-session' ? '⚠️' : '❌';
      console.log(`${statusEmoji} ${id.padEnd(15)} - ${data.status.toUpperCase()}`);
      console.log(`   📝 ${data.message}`);
      
      if (data.username) {
        console.log(`   👤 User: ${data.username} (ID: ${data.user_id})`);
      }
      console.log('');
    } catch (err) {
      console.log(`❌ ${id.padEnd(15)} - Error: ${err.message}\n`);
    }
  }
  
  // Check if sessions file exists
  const fs = require('fs');
  const path = require('path');
  const sessionsFile = path.join(__dirname, 'sessions.json');
  
  if (fs.existsSync(sessionsFile)) {
    const sessions = JSON.parse(fs.readFileSync(sessionsFile, 'utf-8'));
    console.log(`📁 Saved sessions: ${Object.keys(sessions).length} instance(s)`);
    Object.entries(sessions).forEach(([id, data]) => {
      const age = ((Date.now() - data.timestamp) / (1000 * 60)).toFixed(1);
      console.log(`   - ${id}: ${age} minutes old`);
    });
  } else {
    console.log('📁 No saved sessions file found yet');
  }
  console.log('');
}

async function debugStatus(id) {
  console.log(`\n🔧 Debug info for ${id}...\n`);
  
  try {
    const resp = await fetch(`${baseUrl}/api/session/status/${id}`);
    const data = await resp.json();
    
    console.log(`Status: ${data.status}`);
    console.log(`Message: ${data.message}`);
    
    if (data.jarContents) {
      console.log(`\nCookies in jar: ${data.jarContents.length}`);
      data.jarContents.forEach((c, i) => {
        console.log(`  ${i+1}. ${c.key} (domain: ${c.domain}, path: ${c.path})`);
      });
    }
    
    if (data.user_id) {
      console.log(`\nAuthenticated as:`);
      console.log(`  User ID: ${data.user_id}`);
      console.log(`  Username: ${data.username}`);
    }
    
    console.log('\n💡 Next step:');
    if (data.status === 'active') {
      console.log(`   ✓ Session is active. Try opening: http://${id}.localhost:5174/web`);
    } else if (data.status === 'no-session') {
      console.log(`   ⚠ No session. You need to login first in the app.`);
    } else {
      console.log(`   ❌ Session invalid. Try re-authenticating.`);
    }
    console.log('');
  } catch (err) {
    console.log(`Error: ${err.message}\n`);
  }
}

async function clearSession(id) {
  console.log(`\n🗑️  Clearing session for ${id}...\n`);
  
  const fs = require('fs');
  const path = require('path');
  const sessionsFile = path.join(__dirname, 'sessions.json');
  
  if (fs.existsSync(sessionsFile)) {
    const sessions = JSON.parse(fs.readFileSync(sessionsFile, 'utf-8'));
    if (sessions[id]) {
      delete sessions[id];
      fs.writeFileSync(sessionsFile, JSON.stringify(sessions, null, 2));
      console.log(`✓ Cleared session for ${id}`);
    } else {
      console.log(`⚠ No session found for ${id}`);
    }
  } else {
    console.log('📁 No sessions file found');
  }
  console.log('');
}

async function testOpen(id, recordId) {
  const url = `http://${id}.localhost:5174/web#model=helpdesk.ticket&id=${recordId}&view_type=form`;
  console.log(`\n🧪 Testing URL: ${url}\n`);
  
  try {
    const resp = await fetch(`http://${id}.localhost:5174/web`);
    const text = await resp.text();
    
    if (text.includes('session_id') || text.includes('Odoo')) {
      console.log('✓ URL responds (may or may not be authenticated)');
    } else {
      console.log('⚠ Unexpected response');
    }
    
    console.log(`\n👉 Open this URL in your browser:`);
    console.log(`   ${url}`);
    console.log('\n📝 Check browser console (F12 → Console) for session injection logs.');
    console.log('');
  } catch (err) {
    console.log(`Error: ${err.message}\n`);
  }
}

(async () => {
  switch (command) {
    case 'status':
      await checkStatus();
      break;
    case 'debug':
      if (!arg1) {
        console.log('Please specify an instance: node check-session.js debug squadsm');
        break;
      }
      await debugStatus(arg1);
      break;
    case 'clear':
      if (!arg1) {
        console.log('Please specify an instance: node check-session.js clear squadsm');
        break;
      }
      await clearSession(arg1);
      break;
    case 'open':
      if (!arg1) {
        console.log('Usage: node check-session.js open squadsm [recordId]');
        break;
      }
      await testOpen(arg1, arg2 || '451');
      break;
    default:
      console.log(`Unknown command: ${command}`);
      console.log('Try: status, debug, clear, or open');
  }
})();
