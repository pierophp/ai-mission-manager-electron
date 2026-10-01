/** Match the Tauri queue's provider and local Markdown terminal-state rules. */
export function implementationTicketIsOpen(state: string): boolean {
  return !["closed", "done", "resolved", "completed", "removed", "cancelled", "canceled"].includes(
    state.trim().toLowerCase(),
  );
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function percentDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

export function composeImplementationQueuePrompt(
  skillDocument: string,
  ticketNumber: number,
  ticketUrl: string,
  specUrl: string,
): string {
  const body = skillDocument.startsWith("---")
    ? (skillDocument.slice(3).split("---", 2)[1] ?? skillDocument)
    : skillDocument;
  const skill = body.trim();
  let readCommand: string;
  if (ticketUrl.startsWith("local:")) {
    const reference = ticketUrl.slice("local:".length);
    const localPath = reference.split("#", 2)[1];
    readCommand = localPath
      ? `cat ${shellQuote(localPath)}`
      : `read ${ticketUrl} (ticket #${ticketNumber})`;
  } else if (ticketUrl.startsWith("file://")) {
    readCommand = `cat ${shellQuote(percentDecode(ticketUrl.slice("file://".length)))}`;
  } else if (ticketUrl.includes("github.com/")) {
    readCommand = `gh issue view ${ticketNumber} --comments`;
  } else if (ticketUrl.includes("/browse/")) {
    const key = ticketUrl.split("/browse/", 2)[1]?.split(/[?#/]/, 1)[0];
    const site = ticketUrl.split("/")[2] ?? "";
    readCommand = key
      ? `twg jira workitem get ${key} --site https://${site} --output json`
      : `read ${ticketUrl} (ticket #${ticketNumber})`;
  } else {
    readCommand = `read ${ticketUrl} (ticket #${ticketNumber})`;
  }
  const completion =
    ticketUrl.startsWith("local:") || ticketUrl.startsWith("file://")
      ? `Reference #${ticketNumber} in the commit message and set this ticket's \`Status:\` line to \`Closed\` when the work is complete. Never change the parent Spec's status.`
      : ticketUrl.includes("github.com/")
        ? `Reference #${ticketNumber} in the commit message and close this sub-issue when the work is complete. Never close the parent spec or any other issue.`
        : `Reference #${ticketNumber} in the commit message and mark this ticket complete in its provider when the work is complete. Never close or change the parent spec.`;
  return `${skill}\n\n## Ticket #${ticketNumber}\n${ticketUrl}\n\nRead the ticket using \`${readCommand}\` before making changes.\n\nParent spec: ${specUrl}\n\n${completion}`;
}
