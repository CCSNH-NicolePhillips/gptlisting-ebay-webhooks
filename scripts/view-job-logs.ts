#!/usr/bin/env tsx
import 'dotenv/config';
import { getJobLogs, LogEntry } from '../src/lib/redis-logger.js';

/**
 * View logs for a SmartDrafts job.
 * 
 * Usage: npx tsx scripts/view-job-logs.ts <jobId> [--level=info] [--filter=keyword]
 */

async function main() {
  const jobId = process.argv[2];
  
  if (!jobId) {
    console.error('Usage: npx tsx scripts/view-job-logs.ts <jobId> [--level=debug|info|warn|error] [--filter=keyword]');
    process.exit(1);
  }

  // Parse options
  const levelArg = process.argv.find(a => a.startsWith('--level='));
  const filterArg = process.argv.find(a => a.startsWith('--filter='));
  
  const minLevel = levelArg?.split('=')[1] || 'debug';
  const filter = filterArg?.split('=')[1]?.toLowerCase();

  const levelPriority: Record<string, number> = {
    debug: 0,
    info: 1,
    warn: 2,
    error: 3,
  };

  console.log(`Fetching logs for job: ${jobId}\n`);

  const logs = await getJobLogs(jobId);

  if (logs.length === 0) {
    console.log('No logs found for this job.');
    console.log('\nNote: Logs expire after 48 hours.');
    return;
  }

  console.log(`Found ${logs.length} log entries\n`);
  console.log('='.repeat(80));

  for (const entry of logs) {
    // Filter by level
    if (levelPriority[entry.level] < levelPriority[minLevel]) continue;
    
    // Filter by keyword
    if (filter && !entry.msg.toLowerCase().includes(filter)) continue;

    const time = new Date(entry.ts).toISOString().slice(11, 23);
    const levelBadge = formatLevel(entry.level);
    
    console.log(`${time} ${levelBadge} ${entry.msg}`);
    
    if (entry.data !== undefined) {
      const dataStr = typeof entry.data === 'string' 
        ? entry.data 
        : JSON.stringify(entry.data, null, 2);
      
      // Indent data
      const indented = dataStr.split('\n').map(line => '           ' + line).join('\n');
      console.log(indented);
    }
  }

  console.log('='.repeat(80));
  console.log(`\nShowing ${logs.length} entries (filter: level>=${minLevel}${filter ? `, keyword="${filter}"` : ''})`);
}

function formatLevel(level: string): string {
  switch (level) {
    case 'debug': return '\x1b[90m[DEBUG]\x1b[0m';
    case 'info':  return '\x1b[36m[INFO]\x1b[0m ';
    case 'warn':  return '\x1b[33m[WARN]\x1b[0m ';
    case 'error': return '\x1b[31m[ERROR]\x1b[0m';
    default: return `[${level.toUpperCase()}]`;
  }
}

main().catch(console.error);
