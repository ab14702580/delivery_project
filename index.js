// ============================================================
// IMPORTS
// ============================================================

const { getAuth } = require("firebase-admin/auth");
const { cert, initializeApp } = require("firebase-admin/app");

const {
  MongoClient,
  ServerApiVersion,
  ObjectId
} = require("mongodb");

const express = require("express");
const cors = require("cors");
const crypto = require("crypto");

require("dotenv").config();


// ============================================================
// FIREBASE ADMIN CONFIGURATION
// ============================================================

// const serviceAccount = require(
//   "./delivery-project-a9185-firebase-adminsdk-fbsvc-fad08dc60e.json"
// );

// const serviceAccount = require("./firebase-admin-key.json");

let fbInitialized = false;
try {
  if (process.env.FB_SERVICE_KEY) {
    const decoded = Buffer.from(process.env.FB_SERVICE_KEY, 'base64').toString('utf8');
    const serviceAccount = JSON.parse(decoded);

    initializeApp({
      credential: cert(serviceAccount),
    });

    fbInitialized = true;
  } else {
    console.warn('FB_SERVICE_KEY not set — Firebase Admin not initialized');
  }
} catch (err) {
  console.error('Firebase initialization error:', err);
}


// ============================================================
// EXPRESS APP CONFIGURATION
// ============================================================

const app = express();
const port = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());


// ============================================================
// GENERATE TRACKING ID
// ============================================================

function generateTrackingId() {
  const prefix = "PKG";

  const date = new Date()
    .toISOString()
    .slice(0, 10)
    .replace(/-/g, "");

  const random = crypto
    .randomBytes(4)
    .toString("hex")
    .toUpperCase()
    .slice(0, 6);

  return `${prefix}-${date}-${random}`;
}


// ============================================================
// FIREBASE TOKEN VERIFICATION MIDDLEWARE
// ============================================================

const verify = async (req, res, next) => {
  try {
    if (!fbInitialized) {
      return res.status(503).send({ message: 'Authentication not configured' });
    }
    const authHeader = req.headers.authorization;

    // Authorization header check
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      return res.status(401).send({
        message: "Unauthorized access",
      });
    }

    // Get token from "Bearer TOKEN"
    const token = authHeader.split(" ")[1];

    // Verify Firebase token
    const decodeToken = await getAuth().verifyIdToken(token);

    // Save decoded user information
    req.user = decodeToken;

    next();

  } catch (error) {
    console.error("Token verification failed:", error);

    return res.status(401).send({
      message: "Unauthorized access",
    });
  }
};


// ============================================================
// STRIPE CONFIGURATION
// ============================================================

let stripe = null;
if (process.env.SECRET_URL) {
  try {
    stripe = require('stripe')(process.env.SECRET_URL);
  } catch (err) {
    console.error('Stripe init error:', err);
  }
} else {
  console.warn('SECRET_URL (Stripe key) not set — Stripe disabled');
}


// ============================================================
// MONGODB CONFIGURATION
// ============================================================

const uri = `
  mongodb://${process.env.DB_USER}:${process.env.DB_PASS}
  @ac-efk2rtp-shard-00-00.hhehsjt.mongodb.net:27017,
  ac-efk2rtp-shard-00-01.hhehsjt.mongodb.net:27017,
  ac-efk2rtp-shard-00-02.hhehsjt.mongodb.net:27017
  /?ssl=true
  &replicaSet=atlas-106i7s-shard-0
  &authSource=admin
  &appName=Cluster0
`.replace(/\s+/g, "");

const client = new MongoClient(uri, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  },
});


// ============================================================
// MAIN DATABASE FUNCTION
// ============================================================
let errorStore = '';

async function run() {
  try {

    // --------------------------------------------------------
    // CONNECT TO MONGODB
    // --------------------------------------------------------

    await client.connect();
errorStore = "this is a connect bottom";
    try {
errorStore = "this is enter of checking"
      await client.db("admin").command({ ping: 1 });

      
       errorStore = "Pinged your deployment. You successfully connected to MongoDB!";
    } catch (pingErr) {
        errorStore =  pingErr.message;
    }


    // --------------------------------------------------------
    // DATABASE & COLLECTIONS
    // --------------------------------------------------------

    const collection = client.db("delivery-cost");

    const userCollection =
      collection.collection("user");

    const riderCollection =
      collection.collection("rider");

    const category =
      collection.collection("cost");

    const paymentCollection =
      collection.collection("payment-history");

    const trackingCollection =
      collection.collection("Tracking Order");


    // ========================================================
    // ADMIN VERIFICATION MIDDLEWARE
    // ========================================================

    const adminVerification = async (req, res, next) => {

      try {

        const email = req.user?.email;

        if (!email) {
          return res.status(403).send({
            message: "forbidden access",
          });
        }

        const query = {
          email,
        };

        const find =
          await userCollection.findOne(query);

        // User must exist and role must be admin
        if (!find || find.role !== "admin") {
          return res.status(403).send({
            message: "forbidden access",
          });
        }

        next();

      } catch (error) {

        console.error(
          "Admin verification error:",
          error
        );

        return res.status(500).send({
          message: "Internal server error",
        });
      }
    };


    // ========================================================
    // TRACKING LOG FUNCTION
    // ========================================================

    const logTracking = async (
      trackingId,
      status
    ) => {

      // Prevent tracking error when required data is missing
      if (!trackingId || !status) {
        console.log(
          "Tracking ID or status is missing"
        );

        return null;
      }

      // Find existing tracking
      const filter =
        await trackingCollection.findOne({
          trackingId: trackingId,
        });


      // ------------------------------------------------------
      // IF TRACKING ALREADY EXISTS
      // ------------------------------------------------------

      if (filter) {

        const query = {
          trackingId,
        };

        const updateData = {
          $set: {
            trackingId,

            status: [
              ...(Array.isArray(filter.status)
                ? filter.status
                : []),
              status,
            ],

            details: status
              .split("-")
              .join(" "),

            createAt: new Date(),
          },
        };

        const update =
          await trackingCollection.updateOne(
            query,
            updateData
          );

        return update;
      }


      // ------------------------------------------------------
      // IF TRACKING DOES NOT EXIST
      // ------------------------------------------------------

      const log = {
        trackingId,

        status: [
          status
        ],

        details: status
          .split("-")
          .join(" "),

        createAt: new Date(),
      };

      const result =
        await trackingCollection.insertOne(log);

      return result;
    };


    // ========================================================
    // RIDER DELIVERED PARCEL API
    // ========================================================

    app.get(
      "/rider/delivery-per-day",
      async (req, res) => {

        try {

          const email =
            req.query.email;


          // --------------------------------------------------
          // PIPELINE
          // --------------------------------------------------

          const pipeline = [

            // First filter delivered parcels
            {
              $match: {
                riderEmail: email,
                deliveryStatus: "percel-delivered",
              },
            },


            // ------------------------------------------------
            // Get tracking information
            // ------------------------------------------------

            {
              $lookup: {

                // IMPORTANT:
                // This must be the actual MongoDB
                // collection name.
                from: "Tracking Order",

                localField: "trackingId",

                foreignField: "trackingId",

                as: "percel_delivery",
              },
            },
            {
              $unwind: "$percel_delivery"
            },
            {
              $match: {
                "percel_delivery.details": "percel delivered"
              }
            },

          ];


          // --------------------------------------------------
          // RUN AGGREGATION
          // --------------------------------------------------

          const result =
            await paymentCollection
              .aggregate(pipeline)
              .toArray();


          res.send(result);

        } catch (error) {

          console.error(
            "Delivery per day error:",
            error
          );

          res.status(500).send({
            message:
              "Error getting delivered parcels",
          });
        }
      }
    );


    // ========================================================
    // ADMIN DASHBOARD - DELIVERY STATUS
    // ========================================================

    app.get(
      "/deliveryStatus",
      async (req, res) => {

        try {

          const pipeLine = [

            // Group parcels by delivery status
            {
              $group: {

                _id: "$deliveryStatus",

                Count: {
                  $sum: 1,
                },
              },
            },


            // Sort by count
            {
              $sort: {
                Count: 1,
              },
            },


            // Rename _id to status
            {
              $project: {

                Count: 1,

                status: "$_id",
              },
            },

          ];


          const result =
            await paymentCollection
              .aggregate(pipeLine)
              .toArray();


          res.send(result);

        } catch (error) {

          console.error(
            "Delivery status error:",
            error
          );

          res.status(500).send({
            message:
              "Error getting delivery status",
          });
        }
      }
    );


    // ========================================================
    // GET TRACKING BY TRACKING ID
    // ========================================================

    app.get(
      "/tracking/:id",
      async (req, res) => {

        try {

          const trackingId =
            req.params.id;

          const result =
            await trackingCollection.findOne({
              trackingId,
            });

          res.send(result);

        } catch (error) {

          console.error(
            "Tracking get error:",
            error
          );

          res.status(500).send({
            message:
              "Error getting tracking information",
          });
        }
      }
    );


    // ========================================================
    // RIDER APIs
    // ========================================================

    app.get(
      "/riders",
      async (req, res) => {

        try {

          const {
            districk,
            status,
            workStatus
          } = req.query;

          const query = {};


          // Filter by status
          if (status) {
            query.status = status;
          }


          // Filter by district
          if (districk) {
            query.RiderDistrick = districk;
          }


          // Filter by work status
          if (workStatus) {
            query.workStatus = workStatus;
          }


          const result =
            await riderCollection
              .find(query)
              .toArray();


          res.send(result);

        } catch (error) {

          console.error(
            "Get riders error:",
            error
          );

          res.status(500).send({
            message:
              "Error getting riders",
          });
        }
      }
    );


    // ========================================================
    // CREATE RIDER
    // ========================================================

    app.post(
      "/rider",
      async (req, res) => {

        try {

          const userData =
            req.body;

          // Default rider information
          userData.role = "rider";
          userData.status = "pending";
          userData.createdAt = new Date();


          const result =
            await riderCollection.insertOne(
              userData
            );


          res.send(result);

        } catch (error) {

          console.error(
            "Create rider error:",
            error
          );

          res.status(500).send({
            message:
              "Error creating rider",
          });
        }
      }
    );


    // ========================================================
    // ASSIGN RIDER TO PARCEL
    // ========================================================

    app.patch(
      "/percelRider/:id",
      async (req, res) => {

        try {

          const {
            riderId,
            riderEmail,
            percelId,
            riderName,
            tracking
          } = req.body;

          const id =
            req.params.id;


          // --------------------------------------------------
          // Validate riderId
          // --------------------------------------------------

          if (!riderId) {
            return res.status(400).send({
              message:
                "riderId is required",
            });
          }


          // --------------------------------------------------
          // Update payment/parcel information
          // --------------------------------------------------

          const query = {
            _id: new ObjectId(id),
          };

          const updateData = {
            $set: {

              deliveryStatus:
                "driver_assign",

              riderId:
                riderId,

              riderName:
                riderName,

              riderEmail:
                riderEmail,
            },
          };


          const result =
            await paymentCollection.updateOne(
              query,
              updateData
            );


          // --------------------------------------------------
          // Update rider work status
          // --------------------------------------------------

          const riderQuery = {
            _id: new ObjectId(riderId),
          };

          const updateRiderData = {
            $set: {
              workStatus: "in_delivery",
            },
          };


          const riderResult =
            await riderCollection.updateOne(
              riderQuery,
              updateRiderData
            );


          // --------------------------------------------------
          // Add tracking log
          // --------------------------------------------------

          await logTracking(
            tracking,
            "in_delivery"
          );


          res.send(riderResult);

        } catch (error) {

          console.error(
            "Assign rider error:",
            error
          );

          res.status(500).send({
            message:
              "Error assigning rider",
          });
        }
      }
    );


    // ========================================================
    // UPDATE RIDER ROLE / STATUS
    // ========================================================

    app.patch(
      "/rider/:id/role",
      verify,
      adminVerification,
      async (req, res) => {

        try {

          const status =
            req.query.status;

          const id =
            req.params.id;

          const email =
            req.query.email;

          const role =
            req.query.role;


          // --------------------------------------------------
          // User query
          // --------------------------------------------------

          const query = {};

          if (email) {
            query.email = email;
          }


          // --------------------------------------------------
          // Update rider
          // --------------------------------------------------

          const filter = {
            _id: new ObjectId(id),
          };

          const updateDoc = {
            $set: {

              status:
                status,

              workStatus:
                "available",

              role:
                role,
            },
          };


          const result =
            await riderCollection.updateOne(
              filter,
              updateDoc
            );


          // --------------------------------------------------
          // Update user role
          // --------------------------------------------------

          if (email) {

            await userCollection.updateOne(
              query,
              {
                $set: {
                  role: role,
                },
              }
            );

          }


          res.send(result);

        } catch (error) {

          console.error(
            "Update rider status error:",
            error
          );

          res.status(500).send({
            message:
              "Error updating rider status",
          });
        }
      }
    );


    // ========================================================
    // UPDATE USER ROLE
    // ========================================================

    app.patch(
      "/userGet/:id/role",
      verify,
      adminVerification,
      async (req, res) => {

        try {

          const id =
            req.params.id;


          const data = {
            $set: {
              role:
                req.body.role,
            },
          };


          const query = {
            _id: new ObjectId(id),
          };


          const result =
            await userCollection.updateOne(
              query,
              data
            );


          res.send(result);

        } catch (error) {

          console.error(
            "Update user role error:",
            error
          );

          res.status(500).send({
            message:
              "Error updating user role",
          });
        }
      }
    );


    // ========================================================
    // GET USER ROLE
    // ========================================================

    app.get(
      "/users/:email/role",
      verify,
      async (req, res) => {

        try {

          const email =
            req.params.email;

          const query = {
            email,
          };


          const result =
            await userCollection.findOne(
              query
            );


          res.send({
            role:
              result?.role || "user",
          });

        } catch (error) {

          console.error(
            "Get user role error:",
            error
          );

          res.status(500).send({
            message:
              "Error getting user role",
          });
        }
      }
    );


    // ========================================================
    // USER APIs
    // ========================================================

    app.get(
      "/user",
      async (req, res) => {

        try {

          const searchText =
            req.query.searchText;

          const query = {};


          // --------------------------------------------------
          // Search user
          // --------------------------------------------------

          if (searchText) {

            const regular =
              new RegExp(
                searchText,
                "i"
              );

            query.$or = [

              {
                displayName:
                  regular,
              },

              {
                email:
                  regular,
              },

              {
                role:
                  regular,
              },

            ];
          }


          const result =
            await userCollection
              .find(query)
              .sort({
                createAt: -1,
              })
              .limit(5)
              .toArray();


          res.send(result);

        } catch (error) {

          console.error(
            "Get users error:",
            error
          );

          res.status(500).send({
            message:
              "Error getting users",
          });
        }
      }
    );


    // ========================================================
    // CREATE USER
    // ========================================================

    app.post(
      "/users",
      async (req, res) => {

        try {

          const userData =
            req.body;

          userData.role = "user";


          // Check existing user
          const check =
            await userCollection.findOne({
              email:
                userData.email,
            });


          if (check) {
            return res.send(check);
          }


          const result =
            await userCollection.insertOne(
              userData
            );


          res.send(result);

        } catch (error) {

          console.error(
            "Create user error:",
            error
          );

          res.status(500).send({
            message:
              "Error creating user",
          });
        }
      }
    );


    // ========================================================
    // PAYMENT HISTORY
    // ========================================================

    app.get(
      "/payment-history",
      verify,
      async (req, res) => {

        try {

          const {
            email,
            deliveryStatus
          } = req.query;


          // --------------------------------------------------
          // Check logged-in user
          // --------------------------------------------------

          if (
            req.user.email !== email
          ) {

            return res.status(403).send({
              message:
                "Forbidden access",
            });

          }


          const query = {};


          // --------------------------------------------------
          // User/Admin filtering
          // --------------------------------------------------

          if (email) {

            const check =
              await userCollection.findOne({
                email:
                  email,
              });


            // Only non-admin user gets customerEmail filter
            if (
              check &&
              check.role !== "admin"
            ) {

              query.customerEmail =
                email;

            }
          }


          // --------------------------------------------------
          // Delivery status filter
          // --------------------------------------------------

          if (deliveryStatus) {

            query.deliveryStatus =
              deliveryStatus;

          }


          const result =
            await paymentCollection
              .find(query)
              .sort({
                paidAt: -1,
              })
              .toArray();


          res.send(result);

        } catch (error) {

          console.error(
            "Payment history error:",
            error
          );

          res.status(500).send({
            message:
              "Error getting payment history",
          });
        }
      }
    );


    // ========================================================
    // GET PARCEL BY SENDER EMAIL
    // ========================================================

    app.get(
      "/perselGet",
      verify,
      async (req, res) => {

        try {

          const {
            email
          } = req.query;


          // Check logged-in user
          if (
            req.user.email !== email
          ) {

            return res.status(403).send({
              message:
                "Forbidden access",
            });

          }


          const query = {};


          if (email) {

            query.senderEmail =
              email;

          }


          const result =
            await category
              .find(query)
              .toArray();


          res.send(result);

        } catch (error) {

          console.error(
            "Get parcel error:",
            error
          );

          res.status(500).send({
            message:
              "Error getting parcels",
          });
        }
      }
    );


    // ========================================================
    // GET RIDER PARCELS
    // ========================================================

    app.get(
      "/percel/rider",
      async (req, res) => {

        try {

          const {
            riderEmail,
            deliveryStatus
          } = req.query;


          const query = {};


          // Filter by rider email
          if (riderEmail) {

            query.riderEmail =
              riderEmail;

          }


          // --------------------------------------------------
          // If delivered status is requested
          // return only delivered parcels
          // --------------------------------------------------

          if (
            deliveryStatus ===
            "percel-delivered"
          ) {

            query.deliveryStatus =
              deliveryStatus;

          }

          // --------------------------------------------------
          // Otherwise exclude delivered parcels
          // --------------------------------------------------

          else {

            query.deliveryStatus = {
              $nin: [
                "percel-delivered"
              ],
            };

          }

          const result = await paymentCollection.find(query).toArray();

          res.send(result);

        } catch (error) {

          console.error(
            "Get rider parcels error:",
            error
          );

          res.status(500).send({
            message:
              "Error getting rider parcels",
          });
        }
      }
    );


    // ========================================================
    // GET SINGLE PARCEL
    // ========================================================

    app.get(
      "/percelGet/:id",

              // Rider update completed

            // Parcel update completed
      async (req, res) => {

        try {

          const params =
            req.params.id;


          const query = {
            _id:
              new ObjectId(params),
          };


          const result =
            await category.findOne(
              query
            );


          res.send(result);

        } catch (error) {

          console.error(
            "Get single parcel error:",
            error
          );

          res.status(500).send({
            message:
              "Error getting parcel",
          });
        }
      }
    );


    // ========================================================
    // CREATE PARCEL
    // ========================================================

    app.post(
      "/persel",
      async (req, res) => {

        try {

          const cost =
            req.body;


          // Create date
          cost.createAt =
            new Date();


          // Generate tracking ID
          const trackingId =
            generateTrackingId();


          cost.trackingId =
            trackingId;


          // Save tracking history
          await logTracking(
            trackingId,
            "payment_complete"
          );


          // Insert parcel
          const result =
            await category.insertOne(
              cost
            );


          res.send(result);

        } catch (error) {

          console.error(
            "Create parcel error:",
            error
          );

          res.status(500).send({
            message:
              "Error creating parcel",
          });
        }
      }
    );


    // ========================================================
    // CREATE STRIPE CHECKOUT SESSION
    // ========================================================

    app.post(
      "/create-payment-checkout",
      async (req, res) => {

        try {

          const paymentInfo =
            req.body;

          if (!stripe) {
            return res.status(500).send({ message: 'Stripe not configured' });
          }


          // Convert cost into cents
          const amount =
            parseInt(
              paymentInfo.cost
            ) * 100;


          // Create Stripe session
          const session =
            await stripe.checkout.sessions.create({

              line_items: [

                {
                  price_data: {

                    currency: "USD",

                    unit_amount:
                      amount,

                    product_data: {

                      name:
                        paymentInfo.percelName,

                    },

                  },

                  quantity: 1,
                },

              ],


              customer_email:
                paymentInfo.senderEmail,


              mode: "payment",


              // Data that will come back
              // from Stripe
              metadata: {

                percelId:
                  paymentInfo.percelId,

                region:
                  paymentInfo.Region,

                Distric:
                  paymentInfo.distric,

                receiverDistrict:
                  paymentInfo.receiverDistrict,

                trackingId:
                  paymentInfo.trackingId,
              },


              success_url:
                `${process.env.SIDE_URL}/dashboard/payment-success?session_id={CHECKOUT_SESSION_ID}`,

              cancel_url:
                `${process.env.SIDE_URL}/dashboard/payment-cancellend`,
            });


          res.send({
            url:
              session.url,
          });

        } catch (error) {

          console.error(
            "Stripe checkout error:",
            error
          );

          res.status(500).send({
            message:
              "Error creating payment checkout",
          });
        }
      }
    );


    // ========================================================
    // RIDER ACCEPT / UPDATE PARCEL STATUS
    // ========================================================

    app.patch(
      "/percel/:id/status",
      async (req, res) => {

        try {

          const query = {
            _id:
              new ObjectId(
                req.params.id
              ),
          };


          const {
            deliveryStatus,
            riderId,
            tracking
          } = req.body;


          // --------------------------------------------------
          // Update parcel delivery status
          // --------------------------------------------------

          const updateDoc = {
            $set: {

              deliveryStatus:
                deliveryStatus,

            },
          };


          const result =
            await paymentCollection.updateOne(
              query,
              updateDoc
            );


          // --------------------------------------------------
          // Update rider status
          // --------------------------------------------------

          // IMPORTANT:
          // Do not update rider collection if riderId
          // is missing.

          if (riderId) {

            const riderQuery = {
              _id:
                new ObjectId(
                  riderId
                ),
            };


            const riderUpdateData = {
              $set: {

                workStatus:
                  "in_delivery",

              },
            };


            const riderUpdate =
              await riderCollection.updateOne(
                riderQuery,
                riderUpdateData
              );


            // Rider update completed

          }


          // Parcel update completed


          // --------------------------------------------------
          // Update tracking history
          // --------------------------------------------------

          await logTracking(
            tracking,
            deliveryStatus
          );


          res.send(result);

        } catch (error) {

          console.error(
            "Update parcel status error:",
            error
          );

          res.status(500).send({
            message:
              "Error updating parcel status",
          });
        }
      }
    );


    // ========================================================
    // UPDATE SESSION DATA AFTER STRIPE PAYMENT
    // ========================================================

    app.patch(
      "/updateSessionData",
      async (req, res) => {

        try {

          const id =
            req.query.session_id;


          // Session ID required
          if (!id) {

            return res.status(400).send({
              message:
                "session_id is required",
            });

          }


          // --------------------------------------------------
          // Get Stripe session
          // --------------------------------------------------

          if (!stripe) {
            return res.status(500).send({ message: 'Stripe not configured' });
          }

          const decode = await stripe.checkout.sessions.retrieve(id, {
            expand: ["line_items.data.price.product"],
          });


          // --------------------------------------------------
          // Get tracking ID
          // --------------------------------------------------

          const trackingId = decode.metadata?.trackingId;


          // --------------------------------------------------
          // Find existing payment
          // --------------------------------------------------

          let findQuery = {};


          if (
            decode.metadata?.percelId
          ) {

            findQuery.percelId =
              decode.metadata.percelId;

          }


          const check =
            await paymentCollection.findOne(
              findQuery
            );


          // --------------------------------------------------
          // Payment already exists
          // --------------------------------------------------

          if (check) {

            return res.send({

              message:
                "payment already exists",

              success:
                true,

              trackingId:
                check.trackingId,

              transactionId:
                decode.payment_intent,

            });

          }


          // --------------------------------------------------
          // Get Parcel Name
          // --------------------------------------------------

          const percelName =
            decode.line_items
              ?.data?.[0]
              ?.price?.product?.name;


          // --------------------------------------------------
          // Update Parcel
          // --------------------------------------------------

          const query = {

            _id:
              new ObjectId(
                decode.metadata.percelId
              ),

          };


          const updateData = {

            $set: {

              paymentStatus:
                decode.payment_status,

              deliveryStatus:
                "pending-picup",

              trackingId:
                trackingId,

            },

          };


          const result =
            await category.updateOne(
              query,
              updateData
            );


          // --------------------------------------------------
          // Payment Information
          // --------------------------------------------------

          const paymentDetails = {

            amount:
              decode.amount_total / 100,

            currency:
              decode.currency,

            customerEmail:
              decode.customer_email,

            percelId:
              decode.metadata.percelId,

            paymentStatus:
              decode.payment_status,

            Region:
              decode.metadata.region,

            Distric:
              decode.metadata.Distric,

            percelName:
              percelName,

            transactionId:
              decode.payment_intent,

            paidAt:
              new Date(),

            trackingId:
              trackingId,

            deliveryStatus:
              "pending-picup",

            receiverDistrict:
              decode.metadata.receiverDistrict,

          };


          // paymentDetails prepared (sensitive fields omitted from logs)


          // --------------------------------------------------
          // Check Payment Status
          // --------------------------------------------------

          if (
            decode.payment_status ===
            "paid"
          ) {

            // Save tracking history
            await logTracking(
              trackingId,
              "pending-picup"
            );


            // Check payment history again
            const filter =
              await paymentCollection.findOne({
                percelId:
                  paymentDetails.percelId,
              });


            // ------------------------------------------------
            // If payment already exists
            // ------------------------------------------------

            if (filter) {

              return res.send({

                success:
                  true,

                paymentDetails:
                  result,

                paymentHistory:
                  filter,

                trackingId:
                  trackingId,

                transactionId:
                  decode.payment_intent,

                percelName:
                  percelName,

              });

            }


            // ------------------------------------------------
            // Insert payment history
            // ------------------------------------------------

            const insertData =
              await paymentCollection.insertOne(
                paymentDetails
              );


            return res.send({

              success:
                true,

              paymentDetails:
                result,

              paymentHistory:
                insertData,

              trackingId:
                trackingId,

              transactionId:
                decode.payment_intent,

              percelName:
                percelName,

            });

          }


          // Payment is not paid
          res.send({
            success:
              true,
          });


        } catch (error) {

          console.error(
            "Update session data error:",
            error
          );

          res.status(500).send({
            message:
              "Error updating session data",
          });
        }
      }
    );


    // ========================================================
    // DELETE PARCEL
    // ========================================================

    app.delete(
      "/delete/:id",
      async (req, res) => {

        try {

          const params =
            req.params.id;


          const query = {
            _id:
              new ObjectId(params),
          };


          const result =
            await category.deleteOne(
              query
            );


          res.send(result);

        } catch (error) {

          console.error(
            "Delete parcel error:",
            error
          );

          res.status(500).send({
            message:
              "Error deleting parcel",
          });
        }
      }
    );


  } catch (error) {

    // ========================================================
    // DATABASE CONNECTION ERROR
    // ========================================================

    console.error(
      "Database connection error:",
      error
    );

  }

}


// ============================================================
// START DATABASE + SERVER
// ============================================================



run().catch((error) => {
  errorStore = 'server error show';
  console.error(
    "Server startup error:",
    error
  );
});

app.get('/', (req, res) => {
  res.send(`server is running ${errorStore || 'outside error'}`);
});

// Only start a listener when running locally (not on Vercel serverless)
if (!process.env.VERCEL) {
  app.listen(port, () => {
    console.log(`Server is running on port ${port}`);
  });
}

// Export app for serverless platforms (Vercel) to use as a handler
module.exports = app;
