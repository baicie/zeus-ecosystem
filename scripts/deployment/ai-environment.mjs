import { randomBytes } from 'node:crypto';
export function createAiDeploymentEnvironment(tenant, options = {}) {
    const publicReplay = options.publicReplay ?? true;
    const token = randomBytes(32).toString('hex');
    const tokens = JSON.stringify([
        {
            token,
            tenantId: tenant,
            userId: 'workbench-viewer',
            role: 'viewer',
        },
    ]);
    const tenants = JSON.stringify([
        {
            id: tenant,
            databaseFile: '/data/ai.sqlite',
            workspaceRoot: '/data/workspace',
        },
    ]);
    return {
        token,
        lines: [
            'ZEUS_AI_MODE=replay',
            `ZEUS_AI_PUBLIC_REPLAY=${publicReplay ? 'true' : 'false'}`,
            `ZEUS_AI_TOKENS='${tokens}'`,
            `ZEUS_AI_TENANTS='${tenants}'`,
            `ZEUS_AI_UPSTREAM_TOKEN=${token}`,
        ],
    };
}
