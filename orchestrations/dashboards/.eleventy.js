const path = require('node:path');
const fs = require('node:fs');

const DASHBOARD_DIR = path.join('orchestrations', 'dashboards');
const OUTPUT_DIR = path.join(DASHBOARD_DIR, 'live');
const ABS_DASHBOARD_DIR = path.resolve(__dirname);
const ABS_LOG_SOURCE = path.resolve(ABS_DASHBOARD_DIR, '..', 'logs');
const ABS_LOG_DEST = path.join(ABS_DASHBOARD_DIR, 'live', 'logs');

const DASHBOARD_FILES = [
  'agent-messages.html',
  'agent-profiles.html',
  'agents-orchestration.html',
  'cpa-details.html',
  'epam-cli-guide.html',
  'monitor.html',
  'orchestration-plan.html',
  'phase-cost-monitor.html',
  'prd-viewer.html',
  'quality-dashboard.html',
  'specification.html'
];

const WATCH_TARGETS = [
  '../prd.json',
  '../agents/profiles.json',
  '../logs/**/*.json',
  '../logs/**/*.jsonl',
  '../scripts/run-agent-orchestration.sh',
  '../scripts/update-monitor.sh'
];

const LOG_FILE_REGEX = /\.(json|jsonl|ndjson)$/i;

function copyLogTree(src, dest) {
  if (!fs.existsSync(src)) return;
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyLogTree(srcPath, destPath);
    } else if (entry.isFile() && LOG_FILE_REGEX.test(entry.name)) {
      fs.mkdirSync(path.dirname(destPath), { recursive: true });
      const srcStat = fs.statSync(srcPath);
      let shouldCopy = true;
      try {
        const destStat = fs.statSync(destPath);
        if (destStat.mtimeMs === srcStat.mtimeMs && destStat.size === srcStat.size) {
          shouldCopy = false;
        }
      } catch {
        // dest missing
      }
      if (shouldCopy) {
        fs.copyFileSync(srcPath, destPath);
        try {
          fs.utimesSync(destPath, srcStat.atime, srcStat.mtime);
        } catch {
          // ignore utimes errors
        }
      }
    }
  }
}

function pruneLogTree(src, dest) {
  if (!fs.existsSync(dest)) return;
  for (const entry of fs.readdirSync(dest, { withFileTypes: true })) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      if (!fs.existsSync(srcPath)) {
        fs.rmSync(destPath, { recursive: true, force: true });
        continue;
      }
      pruneLogTree(srcPath, destPath);
      try {
        if (!fs.readdirSync(destPath).length) {
          fs.rmdirSync(destPath);
        }
      } catch {
        // ignore
      }
    } else if (!fs.existsSync(srcPath) || !LOG_FILE_REGEX.test(entry.name)) {
      fs.rmSync(destPath, { force: true });
    }
  }
}

function syncLogArtifacts() {
  if (!fs.existsSync(ABS_LOG_SOURCE)) {
    fs.rmSync(ABS_LOG_DEST, { recursive: true, force: true });
    return;
  }
  copyLogTree(ABS_LOG_SOURCE, ABS_LOG_DEST);
  pruneLogTree(ABS_LOG_SOURCE, ABS_LOG_DEST);
}

module.exports = function (eleventyConfig) {
  // Copy locked dashboard templates as-is.
  DASHBOARD_FILES.forEach((file) => {
    const src = path.join(DASHBOARD_DIR, file);
    eleventyConfig.addPassthroughCopy({ [src]: file });
  });

  // Passthrough supporting assets/data from orchestrations runtime.
  eleventyConfig.addPassthroughCopy({ [path.join('orchestrations', 'prd.json')]: 'prd.json' });
  eleventyConfig.addPassthroughCopy({
    [path.join('orchestrations', 'agents', 'profiles.json')]: 'profiles.json'
  });
  eleventyConfig.addPassthroughCopy({ [path.join(DASHBOARD_DIR, 'diagrams')]: 'diagrams' });
  eleventyConfig.addPassthroughCopy({ [path.join(DASHBOARD_DIR, 'runtime')]: 'runtime' });

  // Watch orchestration inputs so BrowserSync reloads when runs update.
  WATCH_TARGETS.forEach((target) => {
    eleventyConfig.addWatchTarget(path.resolve(__dirname, target));
  });

  syncLogArtifacts();
  eleventyConfig.on('eleventy.before', () => {
    syncLogArtifacts();
  });
  eleventyConfig.on('watchChange', (changedPath) => {
    if (!changedPath) return;
    const absChanged = path.resolve(changedPath);
    if (absChanged.startsWith(ABS_LOG_SOURCE)) {
      syncLogArtifacts();
    }
  });

  eleventyConfig.setServerOptions({
    port: Number(process.env.EPAM_DASH_PORT || 8093),
    showAllHosts: true
  });

  return {
    dir: {
      input: DASHBOARD_DIR,
      includes: '_includes',
      data: '_data',
      output: OUTPUT_DIR
    },
    templateFormats: ['11ty.js'],
    passthroughFileCopy: true
  };
};
