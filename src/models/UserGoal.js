import mongoose from 'mongoose';

const userGoalSchema = new mongoose.Schema({
  puuid: { type: String, required: true, index: true },
  type: { type: String, enum: ['LP', 'CS10', 'WIN_RATE'], required: true },
  targetValue: { type: Number, required: true },
  currentValue: { type: Number, default: 0 },
  deadline: Date,
  completed: { type: Boolean, default: false }
}, { timestamps: true });

export default mongoose.models.UserGoal || mongoose.model('UserGoal', userGoalSchema);