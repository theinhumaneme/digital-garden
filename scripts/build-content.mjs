#!/usr/bin/env node
// Copies content/ → content-build/ and rewrites Obsidian Excalidraw embeds to
// point at their exported SVG siblings so Quartz can render them without the
// excalidraw plugin. The source content/ submodule is left untouched.
//
// Transform: ![[X.excalidraw …]] → ![[X.excalidraw.svg …]]
// Skipped: .excalidraw.md source files (they contain the drawing JSON).
//
// Quartz's link resolver rewrites src on <img>/<video>/<audio>/<iframe>
// but NOT on <object>, which is what SVG embeds render to. To dodge that,
// any SVG referenced from a folder where it doesn't live is copied next to
// the embedding page so the relative URL the browser receives is correct.

import { copyFile, cp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises"
import { existsSync } from "node:fs"
import { join, relative, dirname, basename } from "node:path"
import { fileURLToPath } from "node:url"

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)))
const SRC = join(repoRoot, "content")
const DST = join(repoRoot, "content-build")

const EMBED_REGEX = /(!\[\[[^\]|]*?\.excalidraw)(?=[\s|\]])/g
const SVG_EMBED_MATCH = /!\[\[([^\]|]*?\.excalidraw\.svg)(?:\s*\|[^\]]*)?\]\]/g

async function* walkMarkdown(dir) {
  const entries = await readdir(dir, { withFileTypes: true })
  for (const entry of entries) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      yield* walkMarkdown(full)
    } else if (entry.isFile() && entry.name.endsWith(".md") && !entry.name.endsWith(".excalidraw.md")) {
      yield full
    }
  }
}

async function buildSvgIndex(root) {
  const index = new Map()
  async function visit(dir) {
    const entries = await readdir(dir, { withFileTypes: true })
    for (const entry of entries) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) await visit(full)
      else if (entry.isFile() && entry.name.endsWith(".excalidraw.svg")) {
        if (!index.has(entry.name)) index.set(entry.name, [])
        index.get(entry.name).push(full)
      }
    }
  }
  await visit(root)
  return index
}

async function main() {
  if (!existsSync(SRC)) {
    console.error(`✗ Source directory not found: ${SRC}`)
    process.exit(1)
  }

  console.log(`→ Cleaning ${relative(repoRoot, DST)}/`)
  await rm(DST, { recursive: true, force: true })

  console.log(`→ Copying content/ → content-build/`)
  await cp(SRC, DST, { recursive: true, dereference: false })

  console.log(`→ Rewriting Excalidraw embeds in content-build/`)
  let filesChanged = 0
  let embedsRewritten = 0
  for await (const file of walkMarkdown(DST)) {
    const original = await readFile(file, "utf8")
    let count = 0
    const transformed = original.replace(EMBED_REGEX, (_, prefix) => {
      count++
      return `${prefix}.svg`
    })
    if (count > 0) {
      await writeFile(file, transformed, "utf8")
      filesChanged++
      embedsRewritten += count
    }
  }
  console.log(`✓ Files changed: ${filesChanged}`)
  console.log(`✓ Embeds rewritten: ${embedsRewritten}`)

  console.log(`→ Co-locating SVGs with their embedding pages`)
  const svgIndex = await buildSvgIndex(DST)
  const missingSvgs = new Set()
  let svgsCopied = 0
  const copiedPaths = new Set()

  for await (const file of walkMarkdown(DST)) {
    const content = await readFile(file, "utf8")
    const pageDir = dirname(file)
    const matches = content.matchAll(SVG_EMBED_MATCH)
    for (const m of matches) {
      const refPath = m[1].trim()
      const fileName = basename(refPath)
      const sources = svgIndex.get(fileName)
      if (!sources || sources.length === 0) {
        missingSvgs.add(`${relative(DST, file)}: ${refPath}`)
        continue
      }
      // Already sitting next to the page? Nothing to do.
      const colocated = join(pageDir, fileName)
      if (sources.includes(colocated)) continue
      // Copy from the first known source.
      if (copiedPaths.has(colocated)) continue
      await copyFile(sources[0], colocated)
      copiedPaths.add(colocated)
      svgsCopied++
    }
  }
  console.log(`✓ SVGs co-located with embedding pages: ${svgsCopied}`)

  if (missingSvgs.size > 0) {
    const isCI = process.env.CI === "true"
    const log = isCI ? console.error : console.warn
    const icon = isCI ? "✗" : "⚠"
    log(`${icon} ${missingSvgs.size} embed(s) reference an SVG not found on disk:`)
    for (const m of [...missingSvgs].slice(0, 20)) log(`  ${m}`)
    if (missingSvgs.size > 20) log(`  …and ${missingSvgs.size - 20} more`)
    log(`  Re-export SVGs from Obsidian (Excalidraw plugin → Auto-export SVG).`)
    if (isCI) {
      console.error(`\nFailing build to avoid shipping broken image embeds.`)
      process.exit(1)
    }
  }

  console.log(`\nDone. Build with:  npx quartz build -d content-build`)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
