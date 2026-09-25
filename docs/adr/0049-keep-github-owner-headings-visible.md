# ADR 0049: Keep GitHub Owner Headings Visible

- Status: Accepted
- Date: 2026-09-25

Always show GitHub owners as Website Path Sections, even when the card has
only one owner or page. Show only the repository name in each nested Path
Group pill, so `/example` above `/repo` provides the complete path without
repeating the owner inside the pill.

The persistent owner heading removes the need for a conditional full-path
label when generic section suppression would otherwise hide the owner.
Keep the full `owner/repo` cluster identity and existing repository singleton
and PR-splitting behavior. Reserved GitHub routes continue through the
existing generic path-section rules rather than becoming owner sections.
