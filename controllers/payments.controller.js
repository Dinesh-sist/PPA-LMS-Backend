import createRazorpayInstance from '../config/razorpay.config.js'

export const createOrder = async (req, res) => {
  try {
    const razorpayInstance = createRazorpayInstance();

    const amount = 1000; // Hardcoded ₹1000

    const options = {
      amount: amount * 100,
      currency: "INR",
      receipt: `receipt_${Date.now()}`
    };

    const order = await razorpayInstance.orders.create(options);

    return res.status(200).json({
      success: true,
      order
    });

  } catch (error) {
    console.log("CREATE ORDER ERROR:", error);
    return res.status(500).json({
      success: false,
      message: error.message
    });
  }
};

export const verifyPayment = async (req, res) => {
  try {
    const {
      razorpay_order_id,
      razorpay_payment_id,
      razorpay_signature
    } = req.body;

    console.log("VERIFY BODY:", req.body);

    const secret = process.env.RAZORPAY_KEY_SECRET;

    const hmac = crypto.createHmac("sha256", secret);
    hmac.update(`${razorpay_order_id}|${razorpay_payment_id}`);

    const generatedSignature = hmac.digest("hex");

    console.log("Generated:", generatedSignature);
    console.log("Received:", razorpay_signature);

    if (generatedSignature === razorpay_signature) {
      return res.status(200).json({
        success: true,
        message: "Payment verified successfully"
      });
    } else {
      return res.status(400).json({
        success: false,
        message: "Invalid signature"
      });
    }

  } catch (error) {
    console.log("VERIFY ERROR:", error);
    return res.status(500).json({
      success: false,
      message: error.message
    });
  }
};