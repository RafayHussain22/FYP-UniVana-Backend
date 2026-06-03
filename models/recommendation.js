const mongoose = require("mongoose");

// Cached AI recommendation payload, one per user. Recomputed when
// profileUpdatedAt or schemaVersion changes (see routes/recommend.js).
const recommendationSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      unique: true,
    },
    profileUpdatedAt: { type: Date, required: true },
    schemaVersion: { type: Number, required: true },
    dataVersion: { type: String, default: "" },
    generatedAt: { type: Date, required: true },
    payload: { type: mongoose.Schema.Types.Mixed, required: true },
  },
  { timestamps: true }
);

module.exports = mongoose.model("Recommendation", recommendationSchema);
