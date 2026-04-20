/**
 * Admin Job Runner
 *
 * Spawns scrapper/reminder scripts as child processes and tracks
 * their status + parsed results in memory.
 *
 * Usage:
 *   const { startJob, getJobs } = require("./adminJobs");
 *   const job = startJob("universityScrapper");
 */

const { spawn } = require("child_process");
const path = require("path");
const AdminJob = require("./models/adminJob");

// Where the scrapper scripts live (sibling directory)
const SCRAPPERS_DIR = path.resolve(__dirname, "../Scrappers");

// Python command — override with PYTHON_CMD env var on Windows (e.g. "python" or "py")
const PYTHON = process.env.PYTHON_CMD || "python3";

// Each script we can run from the dashboard
const SCRIPTS = {
  sendReminders: {
    command: "node",
    args: ["sendReminders.js"],
    cwd: __dirname,
    label: "Send Reminder Emails",
  },
  countriesScrapper: {
    command: PYTHON,
    args: ["countries_scrapper.py"],
    cwd: SCRAPPERS_DIR,
    label: "Countries Scrapper",
  },
  universityScrapper: {
    command: PYTHON,
    args: ["university_scrapper.py"],
    cwd: SCRAPPERS_DIR,
    label: "University Scrapper",
  },
  programsScrapper: {
    command: PYTHON,
    args: ["programs_scrapper.py"],
    cwd: SCRAPPERS_DIR,
    label: "Programs Scrapper",
  },
};

// In-memory storage for all jobs we've run
const jobs = new Map();

// Simple counter for job IDs
let nextId = 1;

/**
 * Parse one line of scrapper output and update the results object.
 *
 * Scrapper lines look like:
 *   [CREATED] id=DE:tu-berlin slug=tu-berlin
 *   [UPDATED] id=DE:lmu slug=lmu | changes: name: 'old' → 'new'
 *   [UNCHANGED] id=DE:xyz slug=xyz
 *   [ERROR] id=DE:abc err=timeout
 *
 * sendReminders lines look like:
 *   Sent reminder to user@email.com for TU Berlin
 */
function parseLine(line, results) {
  const trimmed = line.trim();

  if (trimmed.startsWith("[CREATED]")) {
    // Extract the part after [CREATED]
    const detail = trimmed.replace("[CREATED]", "").trim();
    results.created.push(detail);
  } else if (trimmed.startsWith("[UPDATED]")) {
    const detail = trimmed.replace("[UPDATED]", "").trim();
    results.updated.push(detail);
  } else if (trimmed.startsWith("[UNCHANGED]")) {
    results.unchanged += 1;
  } else if (trimmed.startsWith("[ERROR]")) {
    const detail = trimmed.replace("[ERROR]", "").trim();
    results.errors.push(detail);
  } else if (trimmed.startsWith("Sent reminder to")) {
    // sendReminders.js output
    results.created.push(trimmed);
  } else if (trimmed.startsWith("No reminders to send today")) {
    results.created.push(trimmed);
  }
  // All other lines are ignored (connection messages, summaries, etc.)
}

/**
 * Start a script. Returns the job object.
 * Throws an error if the script key is invalid or already running.
 */
function startJob(scriptKey) {
  const script = SCRIPTS[scriptKey];
  if (!script) {
    throw new Error("Unknown script: " + scriptKey);
  }

  // Check if this script is already running
  for (const job of jobs.values()) {
    if (job.scriptKey === scriptKey && job.status === "running") {
      throw new Error("This script is already running");
    }
  }

  const id = String(nextId++);
  const job = {
    id,
    scriptKey,
    label: script.label,
    status: "running",
    startedAt: new Date(),
    finishedAt: null,
    exitCode: null,
    logs: [],
    results: { created: [], updated: [], unchanged: 0, errors: [] },
  };

  jobs.set(id, job);

  // Spawn the process
  const child = spawn(script.command, script.args, {
    cwd: script.cwd,
    env: { ...process.env, PYTHONUNBUFFERED: "1" }, // inherit env + unbuffered python stdout
  });

  // Append a line to job.logs, keeping only the most recent 5000 lines
  const pushLog = (line) => {
    job.logs.push(line);
    if (job.logs.length > 5000) job.logs.shift();
  };

  // Read stdout line by line
  let stdoutBuffer = "";
  child.stdout.on("data", (chunk) => {
    stdoutBuffer += chunk.toString();
    const lines = stdoutBuffer.split("\n");
    // Keep the last incomplete line in the buffer
    stdoutBuffer = lines.pop();
    for (const line of lines) {
      const trimmed = line.trimEnd();
      if (trimmed) {
        pushLog(trimmed);
        parseLine(trimmed, job.results);
      }
    }
  });

  // Also capture stderr (some scripts print errors here)
  child.stderr.on("data", (chunk) => {
    const lines = chunk.toString().split("\n");
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed) {
        pushLog(trimmed);
        job.results.errors.push(trimmed);
      }
    }
  });

  const persist = async () => {
    try {
      await AdminJob.create({
        scriptKey: job.scriptKey,
        label: job.label,
        status: job.status,
        startedAt: job.startedAt,
        finishedAt: job.finishedAt,
        exitCode: job.exitCode,
        logs: job.logs,
        results: job.results,
      });
    } catch (err) {
      console.error("[adminJobs] failed to save job to DB:", err.message);
    }
  };

  child.on("close", async (code) => {
    // Process any remaining data in the buffer
    if (stdoutBuffer.trim()) {
      pushLog(stdoutBuffer.trim());
      parseLine(stdoutBuffer, job.results);
    }
    job.status = code === 0 ? "completed" : "failed";
    job.exitCode = code;
    job.finishedAt = new Date();
    await persist();
  });

  child.on("error", async (err) => {
    job.status = "failed";
    job.exitCode = -1;
    job.finishedAt = new Date();
    pushLog(err.message);
    job.results.errors.push(err.message);
    await persist();
  });

  return job;
}

/**
 * Get all jobs, most recent first.
 */
function getJobs() {
  return Array.from(jobs.values()).reverse();
}

/**
 * Get a single job by ID.
 */
function getJob(id) {
  return jobs.get(id) || null;
}

module.exports = { startJob, getJobs, getJob, SCRIPTS };
