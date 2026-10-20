#!/usr/bin/env node

import { mkdirSync, existsSync, cpSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, '..');

const HOME = process.env.HOME || process.env.USERPROFILE;
const OPENCODE_CONFIG_DIR = join(HOME, '.config', 'opencode');
const OPENCODE_PLUGINS_DIR = join(OPENCODE_CONFIG_DIR, 'plugins');
const OPENCODE_SKILLS_DIR = join(OPENCODE_CONFIG_DIR, 'skills');

const SKILL_NAMES = ['mem-search', 'mem-capture', 'mem-profile', 'mem-remember', 'mem-focus'];

function install() {
  console.log('Installing opencode-mem...\n');

  console.log('1. Building project...');
  try {
    execSync('npm run build:all', { cwd: PROJECT_ROOT, stdio: 'inherit' });
  } catch {
    console.error('Build failed. Run "npm install && npm run build:all" manually.');
    process.exit(1);
  }

  console.log('\n2. Installing plugin...');
  mkdirSync(OPENCODE_PLUGINS_DIR, { recursive: true });
  const bundlePath = join(PROJECT_ROOT, 'dist', 'opencode-mem.bundle.js');
  const destPath = join(OPENCODE_PLUGINS_DIR, 'opencode-mem.js');

  if (!existsSync(bundlePath)) {
    console.error(`Bundle not found at ${bundlePath}`);
    process.exit(1);
  }

  cpSync(bundlePath, destPath);
  console.log(`  Plugin installed to ${destPath}`);

  console.log('\n3. Installing skills...');
  mkdirSync(OPENCODE_SKILLS_DIR, { recursive: true });
  const skillsDir = join(PROJECT_ROOT, 'skills');

  for (const skill of SKILL_NAMES) {
    const src = join(skillsDir, skill);
    const dest = join(OPENCODE_SKILLS_DIR, skill);
    if (existsSync(src)) {
      cpSync(src, dest, { recursive: true });
      console.log(`  Skill installed: ${skill}`);
    }
  }

  console.log('\nInstallation complete!');
  console.log('\nNext steps:');
  console.log('  1. Configure the plugin: set MEM_SERVER_URL + MEM_API_KEY env vars,');
  console.log('     or create ~/.config/opencode/mem/config.json (see config.example.json)');
  console.log('  2. Start the Worker (see server/README.md)');
  console.log('  3. Restart OpenCode');
  console.log('  4. Tools available: mem_capture, mem_search, mem_focus, mem_list, mem_profile, mem_health, mem_skill_sync');
  console.log('\nRequires OpenCode V2 (2.0.x). The plugin uses the V2 plugin API');
  console.log('(Plugin.define + ctx.tool/session hooks). OpenCode V2 auto-loads');
  console.log('files placed in ~/.config/opencode/plugins/ — no config change needed.');
}

install();
