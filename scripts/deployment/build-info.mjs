/**
 * Deterministic build metadata for a product artifact. The digest is computed
 * over every deployed file (excluding build-info.json) so a change to any
 * asset changes the digest. CI uses this digest to bind an artifact or image
 * to the checked-out Core/UI commits; online acceptance compares the served
 * build-info.json with the CI-generated provenance record.
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
export const BUILD_INFO_SCHEMA = 'zeus.build-info/v1';
export const PROVENANCE_SCHEMA = 'zeus.provenance/v1';
/**
 * Lists every deployed file under `distDir` with its digest.
 *
 * `build-info.json` is always excluded: it carries the digest, so including it
 * would make the value depend on itself. Callers may exclude further paths
 * (the demo pairing manifest is the other self-describing file), expressed as
 * paths relative to `distDir` with `/` separators.
 */
export function collectArtifactFiles(distDir, options = {}) {
    const excluded = new Set(['build-info.json', ...(options.exclude ?? [])]);
    const files = [];
    const walk = (directory, prefix) => {
        for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
            const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
            if (excluded.has(relative))
                continue;
            const absolute = path.join(directory, entry.name);
            if (entry.isDirectory()) {
                walk(absolute, relative);
            }
            else if (entry.isFile()) {
                const content = fs.readFileSync(absolute);
                files.push({
                    path: relative,
                    sha256: createHash('sha256').update(content).digest('hex'),
                    bytes: content.byteLength,
                });
            }
        }
    };
    walk(distDir, '');
    /*
     * Byte order, not `localeCompare`. The digest is over this sequence, and
     * `localeCompare` resolves according to the host's locale — two machines with
     * different `LANG` would order `a-b.js` and `a/b.js` differently and compute
     * different digests for the same tree. A digest that depends on who ran it
     * cannot bind an artifact.
     */
    return files.sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
}
export function computeArtifactDigest(files) {
    const hash = createHash('sha256');
    for (const file of files) {
        hash.update(`${file.path}\0${file.sha256}\n`);
    }
    return `sha256:${hash.digest('hex')}`;
}
export function createBuildInfo(options) {
    if (!/^[0-9a-f]{40}$/i.test(options.coreCommit)) {
        throw new Error('coreCommit must be a full 40-character commit');
    }
    if (!/^[0-9a-f]{40}$/i.test(options.uiCommit)) {
        throw new Error('uiCommit must be a full 40-character commit');
    }
    if (options.sourceTree !== undefined &&
        !/^[0-9a-f]{40}$/i.test(options.sourceTree)) {
        throw new Error('sourceTree must be a full 40-character tree id');
    }
    const files = collectArtifactFiles(options.distDir);
    if (files.length === 0)
        throw new Error('artifact contains no deployable files');
    return {
        schema: BUILD_INFO_SCHEMA,
        products: [...new Set(options.products)].sort(),
        coreCommit: options.coreCommit,
        uiCommit: options.uiCommit,
        ...(options.sourceTree ? { sourceTree: options.sourceTree } : {}),
        version: options.version,
        builtAt: options.builtAt,
        artifactDigest: computeArtifactDigest(files),
        files,
        ...(options.uiSources ? { uiSources: options.uiSources } : {}),
    };
}
export function writeBuildInfo(info, distDir) {
    const output = path.join(distDir, 'build-info.json');
    fs.writeFileSync(output, `${JSON.stringify(info, null, 2)}\n`);
    return output;
}
export function verifyDeployedBuildInfo(value, expected) {
    const errors = [];
    if (!isRecord(value))
        return ['build-info must be an object'];
    if (value.schema !== BUILD_INFO_SCHEMA) {
        errors.push(`build-info schema must be ${BUILD_INFO_SCHEMA}`);
    }
    const products = Array.isArray(value.products)
        ? value.products.filter((item) => typeof item === 'string')
        : [];
    for (const product of expected.products) {
        if (!products.includes(product)) {
            errors.push(`build-info is missing product ${product}`);
        }
    }
    if (value.coreCommit !== expected.coreCommit) {
        errors.push(`build-info coreCommit ${String(value.coreCommit)} does not match ${expected.coreCommit}`);
    }
    if (value.uiCommit !== expected.uiCommit) {
        errors.push(`build-info uiCommit ${String(value.uiCommit)} does not match ${expected.uiCommit}`);
    }
    if (expected.sourceTree !== undefined) {
        if (value.sourceTree === undefined) {
            errors.push('build-info is missing sourceTree');
        }
        else if (value.sourceTree !== expected.sourceTree) {
            errors.push(`build-info sourceTree ${String(value.sourceTree)} does not match ${expected.sourceTree}`);
        }
    }
    if (value.artifactDigest !== expected.artifactDigest) {
        errors.push(`build-info artifactDigest ${String(value.artifactDigest)} does not match ${expected.artifactDigest}`);
    }
    if (expected.imageDigest &&
        value.imageDigest !== undefined &&
        value.imageDigest !== expected.imageDigest) {
        errors.push(`build-info imageDigest ${String(value.imageDigest)} does not match ${expected.imageDigest}`);
    }
    if (typeof value.builtAt !== 'string' || !value.builtAt) {
        errors.push('build-info builtAt must be a non-empty string');
    }
    return errors;
}
export function verifyProvenance(value, expected) {
    if (!isRecord(value))
        return { errors: ['provenance must be an object'] };
    const errors = [];
    if (value.schema !== PROVENANCE_SCHEMA) {
        errors.push(`provenance schema must be ${PROVENANCE_SCHEMA}`);
    }
    if (value.coreCommit !== expected.coreCommit) {
        errors.push('provenance coreCommit does not match the manifest');
    }
    if (value.uiCommit !== expected.uiCommit) {
        errors.push('provenance uiCommit does not match the manifest');
    }
    if (typeof value.runId !== 'string' || !value.runId) {
        errors.push('provenance runId must be a non-empty string');
    }
    const records = Array.isArray(value.products) ? value.products : [];
    for (const product of expected.products) {
        const record = records.find(entry => isRecord(entry) && entry.product === product.product);
        if (!isRecord(record)) {
            errors.push(`provenance is missing ${product.product}`);
            continue;
        }
        if (record.artifactDigest !== product.artifactDigest) {
            errors.push(`provenance ${product.product} artifactDigest does not match the manifest`);
        }
        if (product.imageDigest && record.imageDigest !== product.imageDigest) {
            errors.push(`provenance ${product.product} imageDigest does not match the manifest`);
        }
        if (!isRecord(record.buildInfo)) {
            errors.push(`provenance ${product.product} buildInfo is missing`);
        }
    }
    return errors.length > 0
        ? { errors }
        : { record: value, errors };
}
function isRecord(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
