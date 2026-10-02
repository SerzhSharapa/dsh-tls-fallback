import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
const root = new URL('../', import.meta.url);
const variants = ['README.md', 'README.ru-RU.md', 'README.zh-CN.md'];
const docs = variants.map(file => readFileSync(new URL(file, root), 'utf8'));

test('all README variants have reciprocal languages, useful start and valid local links', () => {
  for (const [index, text] of docs.entries()) {
    assert.ok(text.startsWith('<h1 align="center">DSH TLS Fallback</h1>'));
    assert.match(text, /## (Quick Start|Быстрый старт|快速开始)\n\n1\./);
    assert.doesNotMatch(text.split('## ')[1], /align="center"/);
    assert.doesNotMatch(text, /mermaid|star-history|\/Users\//i);
    for (const file of variants) assert.ok(text.includes(`href="./${file}"`));
    for (const link of text.matchAll(/(?:href="|src="|\]\()(\.\/[^"\s)]+)/g)) {
      assert.ok(existsSync(new URL(link[1], root)), `${variants[index]}: ${link[1]}`);
    }
  }
});

test('README commands, architecture and release identifiers remain technically identical', () => {
  const blocks = text => [...text.matchAll(/```(?:bash|text)\n([\s\S]*?)```/g)].map(m => m[1]);
  for (const text of docs.slice(1)) assert.deepEqual(blocks(text), blocks(docs[0]));
  for (const text of docs) {
    for (const id of ['0.2.0-rc.2', '22.19+', 'dsh-tls-fallback-0.1.0.tgz', 'MIT', '250', '8']) assert.ok(text.includes(id));
  }
});
