const mongoose = require("mongoose");

const adminJobSchema = new mongoose.Schema(
  {
    scriptKey: { type: String, required: true },
    label: { type: String, required: true },
    status: { type: String, enum: ["completed", "failed"], required: true },
    startedAt: { type: Date, required: true },
    finishedAt: { type: Date, required: true },
    exitCode: { type: Number },
    logs: [String],
    results: {
      created: [String],
      updated: [String],
      unchanged: Number,
      errors: [String],
    },
  },
  { timestamps: true }
);

module.exports = mongoose.model("AdminJob", adminJobSchema);
