import { app } from 'electron';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

// Remembers, per site, which element holds the view counter (taught by the user clicking on it).
// Stored as JSON in the app's user data folder so it survives restarts and updates.

export function createSiteRules() {
  const file = path.join(app.getPath('userData'), 'site-rules.json');
  let rules = {};
  try {
    rules = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    // First run or unreadable file: start with no rules
  }
  return {
    get: (site) => rules[site] ?? null,
    set(site, rule) {
      rules[site] = { ...rule, savedAt: new Date().toISOString() };
      writeFileSync(file, JSON.stringify(rules, null, 2));
    },
    remove(site) {
      delete rules[site];
      writeFileSync(file, JSON.stringify(rules, null, 2));
    },
  };
}
