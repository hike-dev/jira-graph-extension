export interface ProjectRef {
  key: string;
  name: string;
}

/** Restricts free-form JQL to the bound project unless it already names a project. */
export function scopeJql(jql: string, project: ProjectRef | undefined): string {
  if (!project || /\bproject\b/i.test(jql)) return jql;
  const m = /^(.*?)\s*(\border\s+by\b.*)?$/is.exec(jql.trim())!;
  const where = m[1].trim();
  return `project = ${project.key}${where ? ` AND (${where})` : ''}${m[2] ? ` ${m[2]}` : ''}`;
}
