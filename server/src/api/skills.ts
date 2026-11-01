import { Router } from 'express';
import type { Db } from '../db/types';

export function createSkillsRouter(db: Db): Router {
  const router = Router();

  router.get('/', (_req, res) => {
    // Skills are stored as files in the .claude/skills directory
    // We load them dynamically so new skills appear automatically
    const skills = loadAvailableSkills();
    res.json({ skills });
  });

  return router;
}

interface SkillDefinition {
  id: string;
  name: string;
  description: string;
  category: 'backend' | 'frontend' | 'security' | 'utility';
}

function loadAvailableSkills(): SkillDefinition[] {
  // This runs on the server, so we can read the filesystem
  // In production, these would be the skills installed in the user's .claude/skills
  // For now, we return the known skills from the codebase
  return [
    {
      id: 'ub-mode',
      name: 'UB Mode',
      description: 'Reduced principles: First Make it Work, Then Make it Right, Follow Practice',
      category: 'utility',
    },
    {
      id: 'safe-editing',
      name: 'Safe Editing',
      description: 'Minimal diffs, senior dev patterns, no hardcoding, production-ready changes',
      category: 'utility',
    },
    {
      id: 'design-taste-frontend',
      name: 'Design Taste Frontend',
      description: 'Anti-slop frontend skill with art direction from 247 curated gallery sites',
      category: 'frontend',
    },
    {
      id: 'ui-ux-pro-max',
      name: 'UI/UX Pro Max',
      description: 'Design intelligence for web, mobile, desktop: accessibility, interaction, responsive layout',
      category: 'frontend',
    },
    {
      id: 'ux-edge-states',
      name: 'UX Edge States',
      description: 'Empty, loading, error, partial, success states — complete UX coverage',
      category: 'frontend',
    },
    {
      id: 'api-security',
      name: 'API Security',
      description: 'OWASP API security patterns: auth, rate limiting, input validation, secrets',
      category: 'security',
    },
    {
      id: 'owasp-top10',
      name: 'OWASP Top 10',
      description: 'Web app security: injection, broken auth, sensitive data exposure, XXE, broken access control',
      category: 'security',
    },
    {
      id: 'audit-team',
      name: 'Audit Team',
      description: 'Multi-perspective code review: security, performance, maintainability, architecture',
      category: 'security',
    },
    {
      id: 'backend-performance',
      name: 'Backend Performance',
      description: 'Database optimization, caching, query tuning, concurrency, profiling',
      category: 'backend',
    },
    {
      id: 'devops-basics',
      name: 'DevOps Basics',
      description: 'CI/CD, containers, infrastructure as code, monitoring, deployment strategies',
      category: 'backend',
    },
    {
      id: 'debug-first',
      name: 'Debug First',
      description: 'Systematic debugging: reproduce, isolate, hypothesize, verify, document',
      category: 'utility',
    },
    {
      id: 'no-hallucination',
      name: 'No Hallucination',
      description: 'Verify APIs exist before using, check package.json, never invent substitutes',
      category: 'utility',
    },
    {
      id: 'explain-bisaya',
      name: 'Explain Bisaya',
      description: 'Translate technical concepts to Bisaya/Cebuano for Filipino developers',
      category: 'utility',
    },
    {
      id: 'caveman',
      name: 'Caveman',
      description: 'Simplify complex explanations to their essence using primitive language',
      category: 'utility',
    },
    {
      id: 'clone',
      name: 'Clone',
      description: 'Replicate patterns from existing code: extract, adapt, apply consistently',
      category: 'utility',
    },
    {
      id: 'rea',
      name: 'REA',
      description: 'Requirements, Execution, Acceptance — structured task decomposition',
      category: 'utility',
    },
    {
      id: 'design-system',
      name: 'Design System',
      description: 'Build cohesive design systems: tokens, components, patterns, documentation',
      category: 'frontend',
    },
    {
      id: 'design',
      name: 'Design',
      description: 'Visual design principles: hierarchy, contrast, alignment, repetition, proximity',
      category: 'frontend',
    },
    {
      id: 'brand',
      name: 'Brand',
      description: 'Brand identity: voice, values, visual language, consistency across touchpoints',
      category: 'frontend',
    },
    {
      id: 'banner-design',
      name: 'Banner Design',
      description: 'Create compelling banners, heroes, and promotional graphics',
      category: 'frontend',
    },
    {
      id: 'slides',
      name: 'Slides',
      description: 'Presentation design: narrative structure, visual hierarchy, data storytelling',
      category: 'frontend',
    },
    {
      id: 'logo-design',
      name: 'Logo Design',
      description: 'Logo creation: concept, typography, mark, color, usage guidelines',
      category: 'frontend',
    },
    {
      id: 'dataviz',
      name: 'Data Visualization',
      description: 'Charts, graphs, dashboards: chart selection, color, accessibility, interaction',
      category: 'frontend',
    },
    {
      id: 'artifact-design',
      name: 'Artifact Design',
      description: 'HTML artifact best practices: structure, theming, capabilities, responsiveness',
      category: 'frontend',
    },
    {
      id: 'artifact-diagramming',
      name: 'Artifact Diagramming',
      description: 'Diagrams for artifacts: architecture, flows, sequence, entity-relationship',
      category: 'frontend',
    },
    {
      id: 'update-config',
      name: 'Update Config',
      description: 'Configure Claude Code via settings.json: hooks, permissions, env vars',
      category: 'utility',
    },
    {
      id: 'keybindings-help',
      name: 'Keybindings Help',
      description: 'Customize keyboard shortcuts, chords, and keybindings.json',
      category: 'utility',
    },
  ];
}