const express = require("express");
const auth = require("../middleware/auth");
const adminAuth = require("../middleware/adminAuth");
const superAdminAuth = require("../middleware/superAdminAuth");
const { startJob, getJobs, getJob } = require("../adminJobs");
const User = require("../models/user");
const AdminJob = require("../models/adminJob");

const router = express.Router();

// All admin routes require login + admin or superadmin role
router.use(auth);
router.use(adminAuth);

// ============================================================
// JOB ROUTES (available to both admin and superadmin)
// ============================================================

// POST /admin/jobs/:scriptKey/run  —  trigger a script
router.post("/jobs/:scriptKey/run", (req, res) => {
  try {
    const job = startJob(req.params.scriptKey);
    res.json({ ok: true, job });
  } catch (err) {
    res.status(409).json({ ok: false, message: err.message });
  }
});

// GET /admin/jobs  —  list all jobs (frontend polls this)
router.get("/jobs", (req, res) => {
  res.json({ ok: true, jobs: getJobs() });
});

// GET /admin/jobs/history  —  last 10 completed/failed jobs from DB
router.get("/jobs/history", async (req, res) => {
  try {
    const history = await AdminJob.find()
      .sort({ startedAt: -1 })
      .limit(10)
      .lean();
    res.json({ ok: true, history });
  } catch (err) {
    res.status(500).json({ ok: false, message: "Failed to fetch history" });
  }
});

// GET /admin/jobs/:id  —  get one job's details
router.get("/jobs/:id", (req, res) => {
  const job = getJob(req.params.id);
  if (!job) return res.status(404).json({ ok: false, message: "Job not found" });
  res.json({ ok: true, job });
});

// ============================================================
// USER MANAGEMENT ROUTES (superadmin only)
// ============================================================

// GET /admin/users  —  list users with search and pagination
//   ?search=email@example    (optional, filters by email)
//   ?page=1                  (optional, defaults to 1)
//   ?limit=5                 (optional, defaults to 5)
router.get("/users", superAdminAuth, async (req, res) => {
  try {
    const search = req.query.search || "";
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.max(1, parseInt(req.query.limit) || 5);
    const skip = (page - 1) * limit;

    // If search is provided, filter by email (case-insensitive partial match)
    const filter = search
      ? { email: { $regex: search, $options: "i" } }
      : {};

    // Sort: superadmin first, then admin, then user.
    // Within each group, oldest first (createdAt ascending).
    const users = await User.aggregate([
      { $match: filter },
      {
        $addFields: {
          rolePriority: {
            $switch: {
              branches: [
                { case: { $eq: ["$role", "superadmin"] }, then: 0 },
                { case: { $eq: ["$role", "admin"] }, then: 1 },
              ],
              default: 2, // regular user
            },
          },
        },
      },
      { $sort: { rolePriority: 1, createdAt: 1 } },
      { $skip: skip },
      { $limit: limit },
      { $project: { name: 1, email: 1, role: 1, createdAt: 1 } },
    ]);

    const total = await User.countDocuments(filter);

    res.json({
      ok: true,
      users,
      total,
      page,
      totalPages: Math.ceil(total / limit),
    });
  } catch (err) {
    res.status(500).json({ ok: false, message: "Failed to fetch users" });
  }
});

// PUT /admin/users/:id/role  —  change a user's role (admin or user)
router.put("/users/:id/role", superAdminAuth, async (req, res) => {
  try {
    const { role } = req.body;

    // Superadmin can only set "admin" or "user" — not "superadmin"
    if (role !== "admin" && role !== "user") {
      return res.status(400).json({
        ok: false,
        message: "Role must be 'admin' or 'user'",
      });
    }

    // Don't allow changing your own role
    if (req.params.id === req.user.id) {
      return res.status(400).json({
        ok: false,
        message: "You cannot change your own role",
      });
    }

    const user = await User.findById(req.params.id);
    if (!user) {
      return res.status(404).json({ ok: false, message: "User not found" });
    }

    // Don't allow changing another superadmin's role
    if (user.role === "superadmin") {
      return res.status(400).json({
        ok: false,
        message: "Cannot change a super admin's role",
      });
    }

    user.role = role;
    await user.save();

    res.json({ ok: true, user: { _id: user._id, name: user.name, email: user.email, role: user.role } });
  } catch (err) {
    res.status(500).json({ ok: false, message: "Failed to update role" });
  }
});

module.exports = router;
