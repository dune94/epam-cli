import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { FileSystemSnapshot, type FileChange } from '../../../src/agent/FileSystemSnapshot.js';
import { writeFile, readFile, mkdir } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { existsSync, rmSync } from 'fs';

describe('FileSystemSnapshot', () => {
  let testDir: string;
  let snapshot: FileSystemSnapshot;

  beforeEach(async () => {
    testDir = join(tmpdir(), `fs-snapshot-test-${Date.now()}`);
    await mkdir(testDir, { recursive: true });
    snapshot = new FileSystemSnapshot(testDir);
  });

  afterEach(() => {
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  describe('capture', () => {
    it('should capture existing files', async () => {
      const testFile = join(testDir, 'test.txt');
      await writeFile(testFile, 'original content');

      await snapshot.capture(['test.txt']);

      const captured = snapshot.getSnapshot('test.txt');
      expect(captured).toBeDefined();
      expect(captured?.content).toBe('original content');
      expect(captured?.existed).toBe(true);
    });

    it('should handle non-existent files gracefully', async () => {
      await snapshot.capture(['nonexistent.txt']);

      const captured = snapshot.getSnapshot('nonexistent.txt');
      expect(captured).toBeDefined();
      expect(captured?.existed).toBe(false);
      expect(captured?.content).toBe('');
    });

    it('should capture multiple files', async () => {
      await writeFile(join(testDir, 'file1.txt'), 'content 1');
      await writeFile(join(testDir, 'file2.txt'), 'content 2');

      await snapshot.capture(['file1.txt', 'file2.txt']);

      expect(snapshot.getSnapshotCount()).toBe(2);
      expect(snapshot.getSnapshot('file1.txt')?.content).toBe('content 1');
      expect(snapshot.getSnapshot('file2.txt')?.content).toBe('content 2');
    });
  });

  describe('restore', () => {
    it('should restore files to original content', async () => {
      const testFile = join(testDir, 'test.txt');
      await writeFile(testFile, 'original content');

      await snapshot.capture(['test.txt']);
      
      // Modify the file
      await writeFile(testFile, 'modified content');
      
      // Restore
      await snapshot.restore();

      const restored = await readFile(testFile, 'utf-8');
      expect(restored).toBe('original content');
    });

    it('should delete files that were created after snapshot', async () => {
      const newFile = join(testDir, 'new.txt');
      
      await snapshot.capture(['new.txt']); // File doesn't exist yet
      
      // Create the file
      await writeFile(newFile, 'new content');
      expect(existsSync(newFile)).toBe(true);
      
      // Restore should delete it
      await snapshot.restore();
      
      expect(existsSync(newFile)).toBe(false);
    });

    it('should return list of restored paths', async () => {
      await writeFile(join(testDir, 'file1.txt'), 'content 1');
      await writeFile(join(testDir, 'file2.txt'), 'content 2');

      await snapshot.capture(['file1.txt', 'file2.txt']);

      const restored = await snapshot.restore();
      expect(restored.length).toBe(2);
    });
  });

  describe('recordChange', () => {
    it('should record a file change', async () => {
      // First capture the file so snapshot knows it exists
      const testFile = join(testDir, 'test.txt');
      await writeFile(testFile, 'before content');
      await snapshot.capture(['test.txt']);

      const change = snapshot.recordChange('test.txt', 'before content', 'after content');
      
      expect(change.path).toContain('test.txt');
      expect(change.before).toBe('before content');
      expect(change.after).toBe('after content');
      expect(change.isNewFile).toBe(false);
      expect(change.isDeletion).toBe(false);
    });

    it('should mark new files correctly', () => {
      const change = snapshot.recordChange('new.txt', '', 'content');
      expect(change.isNewFile).toBe(true);
    });

    it('should mark deletions correctly', async () => {
      // First capture the file so snapshot knows it exists
      const testFile = join(testDir, 'delete.txt');
      await writeFile(testFile, 'content to delete');
      await snapshot.capture(['delete.txt']);

      const change = snapshot.recordChange('delete.txt', 'content to delete', '');
      expect(change.isDeletion).toBe(true);
    });
  });

  describe('applyChange', () => {
    it('should apply a file change', async () => {
      const testFile = join(testDir, 'test.txt');
      await writeFile(testFile, 'original');

      const change: FileChange = {
        path: 'test.txt',
        before: 'original',
        after: 'modified',
        isNewFile: false,
        isDeletion: false,
      };

      const rollback = await snapshot.applyChange(change);
      
      const content = await readFile(testFile, 'utf-8');
      expect(content).toBe('modified');

      // Rollback
      await rollback();
      const restored = await readFile(testFile, 'utf-8');
      expect(restored).toBe('original');
    });

    it('should create new files', async () => {
      const newFile = join(testDir, 'new.txt');

      const change: FileChange = {
        path: 'new.txt',
        before: '',
        after: 'new content',
        isNewFile: true,
        isDeletion: false,
      };

      await snapshot.applyChange(change);
      
      expect(existsSync(newFile)).toBe(true);
      const content = await readFile(newFile, 'utf-8');
      expect(content).toBe('new content');
    });

    it('should delete files', async () => {
      const testFile = join(testDir, 'delete.txt');
      await writeFile(testFile, 'to delete');

      const change: FileChange = {
        path: 'delete.txt',
        before: 'to delete',
        after: '',
        isNewFile: false,
        isDeletion: true,
      };

      await snapshot.applyChange(change);
      
      expect(existsSync(testFile)).toBe(false);
    });
  });

  describe('estimateDiffTokens', () => {
    it('should estimate tokens for simple changes', () => {
      const change: FileChange = {
        path: 'test.txt',
        before: 'hello world',
        after: 'hello there',
        isNewFile: false,
        isDeletion: false,
      };

      const tokens = snapshot.estimateDiffTokens(change);
      expect(tokens).toBeGreaterThan(0);
    });

    it('should estimate higher tokens for larger changes', () => {
      const small: FileChange = {
        path: 'small.txt',
        before: 'a',
        after: 'b',
        isNewFile: false,
        isDeletion: false,
      };

      const large: FileChange = {
        path: 'large.txt',
        before: 'a'.repeat(100),
        after: 'b'.repeat(100),
        isNewFile: false,
        isDeletion: false,
      };

      expect(snapshot.estimateDiffTokens(large)).toBeGreaterThan(
        snapshot.estimateDiffTokens(small)
      );
    });

    it('should count full file for new files', () => {
      const change: FileChange = {
        path: 'new.txt',
        before: '',
        after: 'new file content here',
        isNewFile: true,
        isDeletion: false,
      };

      const tokens = snapshot.estimateDiffTokens(change);
      expect(tokens).toBeGreaterThan(0);
    });
  });

  describe('edge cases', () => {
    it('should handle relative and absolute paths', async () => {
      const testFile = join(testDir, 'test.txt');
      await writeFile(testFile, 'content');

      // Relative path
      await snapshot.capture(['test.txt']);
      expect(snapshot.getSnapshot('test.txt')).toBeDefined();

      // Absolute path
      await snapshot.capture([testFile]);
      expect(snapshot.getSnapshot(testFile)).toBeDefined();
    });

    it('should clear all snapshots', async () => {
      await writeFile(join(testDir, 'file.txt'), 'content');
      await snapshot.capture(['file.txt']);
      
      expect(snapshot.getSnapshotCount()).toBe(1);
      
      snapshot.clear();
      
      expect(snapshot.getSnapshotCount()).toBe(0);
    });

    it('should get captured paths', async () => {
      await writeFile(join(testDir, 'file1.txt'), 'content 1');
      await writeFile(join(testDir, 'file2.txt'), 'content 2');
      
      await snapshot.capture(['file1.txt', 'file2.txt']);
      
      const paths = snapshot.getCapturedPaths();
      expect(paths.length).toBe(2);
    });
  });
});
