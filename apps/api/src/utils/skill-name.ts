/**
 * A custom skill's name is a file or directory name in the checkout
 * (`.claude/commands/<name>.md`, `.claude/skills/<name>/`): one path segment,
 * never `.` / `..`, no separators or control characters, so a name like
 * `../../x` can't put its files outside `.claude/`.
 */
export function isSafeSkillName(name: string): boolean {
  const trimmed = name.trim();

  return trimmed !== "" && trimmed !== "." && trimmed !== ".." && !/[/\\\x00-\x1f\x7f]/.test(name);
}
