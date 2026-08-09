/**
 * Ticket parsing for the dispatcher.
 *
 * Parses the output of a "to-tickets" style tool into structured Ticket objects.
 * Supports multiple formats:
 * 1. Markdown task list with dependencies
 * 2. JSON array of tickets
 * 3. Simple text format (ID: title)
 */

import type { Ticket } from "./types.ts";
import * as fs from "node:fs";

/**
 * Parse tickets from a raw string.
 * Tries JSON first, then markdown, then simple text.
 */
export function parseTickets(source: string): Ticket[] {
  const trimmed = source.trim();

  // Try JSON first
  if (trimmed.startsWith("[") || trimmed.startsWith("{")) {
    try {
      return parseTicketsFromJson(trimmed);
    } catch {
      // fall through to other formats
    }
  }

  // Try markdown format
  try {
    const markdownTickets = parseTicketsFromMarkdown(trimmed);
    if (markdownTickets.length > 0) {
      return markdownTickets;
    }
  } catch {
    // fall through
  }

  // Try simple text format
  try {
    const simpleTickets = parseTicketsFromSimpleText(trimmed);
    if (simpleTickets.length > 0) {
      return simpleTickets;
    }
  } catch {
    // fall through
  }

  throw new Error("Could not parse tickets from the provided source.");
}

/** Parse tickets from JSON format. */
function parseTicketsFromJson(json: string): Ticket[] {
  const parsed = JSON.parse(json);

  if (Array.isArray(parsed)) {
    return parsed.map(normalizeTicket);
  }

  if (parsed.tickets && Array.isArray(parsed.tickets)) {
    return parsed.tickets.map(normalizeTicket);
  }

  throw new Error("JSON does not contain a ticket array.");
}

/** Normalize a JSON ticket object into our Ticket type. */
function normalizeTicket(obj: any): Ticket {
  const id = String(obj.id || obj.ticket_id || obj.number || "");
  if (!id) {
    throw new Error("Ticket is missing an id.");
  }

  const title = String(obj.title || obj.summary || obj.name || "Untitled");
  const description = String(
    obj.description || obj.body || obj.details || ""
  );

  let dependsOn: string[] = [];
  if (obj.dependsOn && Array.isArray(obj.dependsOn)) {
    dependsOn = obj.dependsOn.map(String);
  } else if (obj.dependencies && Array.isArray(obj.dependencies)) {
    dependsOn = obj.dependencies.map(String);
  } else if (obj.blockedBy && Array.isArray(obj.blockedBy)) {
    dependsOn = obj.blockedBy.map(String);
  }

  let files: string[] | undefined;
  if (obj.files && Array.isArray(obj.files)) {
    files = obj.files.map(String);
  } else if (obj.affectedFiles && Array.isArray(obj.affectedFiles)) {
    files = obj.affectedFiles.map(String);
  }

  let complexity: Ticket["complexity"];
  if (obj.complexity && ["low", "medium", "high"].includes(obj.complexity)) {
    complexity = obj.complexity;
  }

  return {
    id,
    title,
    description,
    dependsOn,
    files,
    complexity,
  };
}

/**
 * Parse tickets from markdown format.
 *
 * Supports:
 * - ## Ticket: ID - Title
 * - - [ ] Ticket: ID - Title
 * - ### Ticket
 *   **ID**: TKT-001
 *   **Title**: ...
 *   **Depends on**: TKT-001, TKT-002
 *   **Description**: ...
 */
function parseTicketsFromMarkdown(markdown: string): Ticket[] {
  const tickets: Ticket[] = [];
  const lines = markdown.split("\n");

  // Pattern 1: Heading-based: ## TKT-001: Title or ## Ticket: TKT-001 - Title
  const headingRegex = /^(?:#{2,3})\s*(?:Ticket:\s*)?([A-Za-z0-9_-]+)[\s:\-]+(.+)$/;

  // Pattern 2: Task list: - [ ] TKT-001: Title
  const taskRegex = /^[-*]\s*\[[ x]\]\s*([A-Za-z0-9_-]+)[\s:\-]+(.+)$/;

  let currentTicket: Partial<Ticket> | null = null;
  let captureDesc = false;
  let descLines: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();

    // Check for heading-based ticket
    const headingMatch = line.match(headingRegex);
    if (headingMatch) {
      if (currentTicket) {
        if (descLines.length > 0) {
          currentTicket.description = descLines.join("\n").trim();
        }
        tickets.push(normalizeTicket(currentTicket));
      }
      currentTicket = {
        id: headingMatch[1],
        title: headingMatch[2].trim(),
        description: "",
        dependsOn: [],
      };
      descLines = [];
      captureDesc = false;
      continue;
    }

    // Check for task-list-based ticket
    const taskMatch = line.match(taskRegex);
    if (taskMatch) {
      if (currentTicket) {
        if (descLines.length > 0) {
          currentTicket.description = descLines.join("\n").trim();
        }
        tickets.push(normalizeTicket(currentTicket));
      }
      currentTicket = {
        id: taskMatch[1],
        title: taskMatch[2].trim(),
        description: "",
        dependsOn: [],
      };
      descLines = [];
      captureDesc = false;
      continue;
    }

    if (!currentTicket) continue;

    // Parse metadata fields: **Key**: value
    const fieldMatch = trimmed.match(
      /^\*\*(Depends on|Depends|Dependencies|Blocked by|Files|Complexity)\*\*:\s*(.+)$/i
    );
    if (fieldMatch) {
      const key = fieldMatch[1].toLowerCase();
      const value = fieldMatch[2].trim();

      if (key.includes("depend") || key.includes("blocked")) {
        currentTicket.dependsOn = value
          .split(/[,\s]+/)
          .map((s) => s.trim())
          .filter((s) => s.length > 0);
      } else if (key === "files") {
        currentTicket.files = value
          .split(/[,\s]+/)
          .map((s) => s.trim())
          .filter((s) => s.length > 0);
      } else if (key === "complexity") {
        const v = value.toLowerCase();
        if (["low", "medium", "high"].includes(v)) {
          currentTicket.complexity = v as Ticket["complexity"];
        }
      }
      captureDesc = false;
      continue;
    }

    // Description header
    if (/^\*\*(Description|Body|Details)\*\*:\s*$/i.test(trimmed)) {
      captureDesc = true;
      continue;
    }

    if (/^\*\*(Description|Body|Details)\*\*:\s*(.+)$/i.test(trimmed)) {
      const m = trimmed.match(/^\*\*(Description|Body|Details)\*\*:\s*(.+)$/i);
      if (m) {
        descLines = [m[2]];
        captureDesc = true;
      }
      continue;
    }

    // Accumulate description lines
    if (captureDesc) {
      descLines.push(line);
    }
  }

  // Don't forget the last ticket
  if (currentTicket) {
    if (descLines.length > 0) {
      currentTicket.description = descLines.join("\n").trim();
    }
    tickets.push(normalizeTicket(currentTicket));
  }

  return tickets;
}

/**
 * Parse tickets from simple text format.
 *
 * Format:
 *   TKT-001: Title of ticket
 *   TKT-002: Another ticket
 *   Depends on: TKT-001
 */
function parseTicketsFromSimpleText(text: string): Ticket[] {
  const tickets: Ticket[] = [];
  const lines = text.split("\n");

  const ticketRegex = /^([A-Za-z0-9_-]+)\s*[:\-]\s+(.+)$/;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith("//")) {
      continue;
    }

    const match = trimmed.match(ticketRegex);
    if (match) {
      tickets.push({
        id: match[1],
        title: match[2].trim(),
        description: "",
        dependsOn: [],
      });
    }
  }

  return tickets;
}

/**
 * Load tickets from a file.
 */
export function loadTicketsFromFile(filePath: string): Ticket[] {
  const content = fs.readFileSync(filePath, "utf-8");
  return parseTickets(content);
}

/**
 * Validate a list of tickets:
 * - No duplicate IDs
 * - All dependency references exist
 */
export function validateTickets(tickets: Ticket[]): void {
  const ids = new Set<string>();

  for (const ticket of tickets) {
    if (!ticket.id) {
      throw new Error("Found ticket with empty ID.");
    }
    if (ids.has(ticket.id)) {
      throw new Error(`Duplicate ticket ID: ${ticket.id}`);
    }
    ids.add(ticket.id);
  }

  for (const ticket of tickets) {
    for (const depId of ticket.dependsOn) {
      if (!ids.has(depId)) {
        throw new Error(
          `Ticket ${ticket.id} depends on non-existent ticket ${depId}`
        );
      }
      if (depId === ticket.id) {
        throw new Error(`Ticket ${ticket.id} depends on itself.`);
      }
    }
  }
}
