import Razorpay from "razorpay";

export default function createRazorpayInstance() {
  console.log("KEY ID:", process.env.RAZORPAY_KEY_ID);
  console.log("KEY SECRET:", process.env.RAZORPAY_KEY_SECRET);
  return new Razorpay({
    key_id: process.env.RAZORPAY_KEY_ID,
    key_secret: process.env.RAZORPAY_KEY_SECRET,
  });
};