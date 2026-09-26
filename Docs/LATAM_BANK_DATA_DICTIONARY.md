# LATAM Bank Dataset --- Data Dictionary

**Source:** Factored Datathon 2026\
**Document type:** Data dictionary\
**Purpose:** Reference for table schemas, fields, constraints, and
relationships.

> **Usage note for agents:** Treat this document as the schema authority
> for the supplied dataset. Preserve table and column names exactly as
> written when generating SQL, code, mappings, or data contracts.

## Fact Tables

Transactional and event data tables containing 7 fact tables.

## Transactions

**Type:** Fact table\
**Rows:** 5,000,000\
**Source:** `Core Banking`\
**Partition:** `daily`

  ---------------------------------------------------------------------------
  Column                   Type              Description      Constraints
  ------------------------ ----------------- ---------------- ---------------
  `transaction_id`         `VARCHAR(30)`     Unique           PK, NOT NULL
                                             transaction ID   

  `transaction_date`       `TIMESTAMP`       Transaction date NOT NULL
                                             and time         

  `process_date`           `DATE`            Process date     NOT NULL
                                             (partition key)  

  `product_id`             `VARCHAR(20)`     Product ID       FK, NOT NULL

  `customer_id`            `VARCHAR(20)`     Customer ID      FK, NOT NULL

  `transaction_type`       `VARCHAR(50)`     Type (Deposit,   NOT NULL
                                             Withdrawal,      
                                             Transfer,        
                                             Payment,         
                                             Purchase,        
                                             Adjustment)      

  `transaction_category`   `VARCHAR(50)`     Category (Food,  \-
                                             Transport,       
                                             Services,        
                                             Entertainment,   
                                             Health, Other)   

  `amount`                 `DECIMAL(15,2)`   Transaction      NOT NULL
                                             amount           

  `currency`               `VARCHAR(3)`      Currency         NOT NULL

  `amount_usd`             `DECIMAL(15,2)`   Amount converted \-
                                             to USD           

  `channel`                `VARCHAR(30)`     Channel (ATM,    NOT NULL
                                             Branch, Web,     
                                             App, POS,        
                                             Transfer)        

  `branch_id`              `VARCHAR(20)`     Branch ID (if    FK
                                             applicable)      

  `merchant_name`          `VARCHAR(150)`    Merchant name    \-
                                             (for purchases)  

  `merchant_category`      `VARCHAR(50)`     MCC merchant     \-
                                             category         

  `transaction_country`    `VARCHAR(50)`     Country where    NOT NULL
                                             transaction      
                                             occurred         

  `transaction_city`       `VARCHAR(100)`    City where       \-
                                             transaction      
                                             occurred         

  `transaction_status`     `VARCHAR(20)`     Status           NOT NULL
                                             (Approved,       
                                             Declined,        
                                             Pending,         
                                             Reversed)        

  `response_code`          `VARCHAR(10)`     System response  \-
                                             code             

  `is_fraud`               `BOOLEAN`         Marked as fraud  NOT NULL

  `fraud_score`            `DECIMAL(5,2)`    Fraud risk score \-
                                             (0-100)          

  `latitude`               `DECIMAL(10,7)`   Transaction      \-
                                             latitude         

  `longitude`              `DECIMAL(10,7)`   Transaction      \-
                                             longitude        
  ---------------------------------------------------------------------------

## Call Center Interactions

**Type:** Fact table\
**Rows:** 800,000\
**Source:** `Contact Center`\
**Partition:** `daily`

  ---------------------------------------------------------------------------------
  Column                       Type             Description         Constraints
  ---------------------------- ---------------- ------------------- ---------------
  `interaction_id`             `VARCHAR(30)`    Unique interaction  PK, NOT NULL
                                                ID                  

  `interaction_date`           `TIMESTAMP`      Interaction date    NOT NULL
                                                and time            

  `process_date`               `DATE`           Process date        NOT NULL
                                                (partition key)     

  `customer_id`                `VARCHAR(20)`    Customer ID         FK, NOT NULL

  `agent_id`                   `VARCHAR(20)`    Agent ID who        FK
                                                attended            

  `interaction_type`           `VARCHAR(30)`    Type (Inbound Call, NOT NULL
                                                Outbound Call,      
                                                Chat, Email, Video) 

  `channel`                    `VARCHAR(30)`    Channel (Phone, Web NOT NULL
                                                Chat, WhatsApp,     
                                                Email, App)         

  `contact_reason`             `VARCHAR(100)`   Main contact reason NOT NULL

  `reason_category`            `VARCHAR(50)`    Category            NOT NULL
                                                (Transactional,     
                                                Product, Technical, 
                                                Commercial,         
                                                Complaint)          

  `duration_seconds`           `INTEGER`        Duration in seconds \-

  `wait_time_seconds`          `INTEGER`        Wait time before    \-
                                                service             

  `was_resolved`               `BOOLEAN`        Resolved on first   \-
                                                call (FCR)          

  `requires_followup`          `BOOLEAN`        Requires follow-up  NOT NULL

  `detected_sentiment`         `VARCHAR(20)`    Sentiment           \-
                                                (Positive, Neutral, 
                                                Negative, Very      
                                                Negative)           

  `sentiment_score`            `DECIMAL(3,2)`   Sentiment score (-1 \-
                                                to 1)               

  `customer_detected_accent`   `VARCHAR(50)`    Customer's detected \-
                                                accent              

  `agent_used_accent`          `VARCHAR(50)`    Accent used by      \-
                                                agent in response   

  `was_escalated`              `BOOLEAN`        Was escalated to    NOT NULL
                                                supervisor          

  `mentioned_products`         `VARCHAR(200)`   Product IDs         \-
                                                mentioned           
                                                (comma-separated)   

  `has_transcript`             `BOOLEAN`        Has transcript      NOT NULL
                                                available           

  `has_recording`              `BOOLEAN`        Has audio recording NOT NULL
  ---------------------------------------------------------------------------------

## Call Transcripts

**Type:** Fact table\
**Rows:** 200,000\
**Source:** `Contact Center`\
**Partition:** `daily`

  ------------------------------------------------------------------------
  Column                  Type             Description     Constraints
  ----------------------- ---------------- --------------- ---------------
  `transcript_id`         `VARCHAR(30)`    Unique          PK, NOT NULL
                                           transcript ID   

  `interaction_id`        `VARCHAR(30)`    Related         FK, NOT NULL
                                           interaction ID  

  `process_date`          `DATE`           Process date    NOT NULL
                                           (partition key) 

  `customer_id`           `VARCHAR(20)`    Customer ID     FK, NOT NULL

  `agent_id`              `VARCHAR(20)`    Agent ID        FK, NOT NULL

  `full_text`             `TEXT`           Full call       NOT NULL
                                           transcript (in  
                                           Spanish)        

  `customer_text`         `TEXT`           Only what       \-
                                           customer said   
                                           (in Spanish)    

  `agent_text`            `TEXT`           Only what agent \-
                                           said (in        
                                           Spanish)        

  `detected_language`     `VARCHAR(10)`    Main language   NOT NULL
                                           detected        

  `detected_accent`       `VARCHAR(50)`    Detected accent \-

  `accent_confidence`     `DECIMAL(3,2)`   Accent          \-
                                           detection       
                                           confidence      
                                           (0-1)           

  `detected_keywords`     `VARCHAR(500)`   Identified      \-
                                           keywords        

  `mentioned_entities`    `TEXT`           Extracted       \-
                                           entities (JSON) 

  `detected_intents`      `VARCHAR(300)`   Identified      \-
                                           intents         

  `main_topics`           `VARCHAR(300)`   Main            \-
                                           conversation    
                                           topics          

  `transcription_model`   `VARCHAR(50)`    Model used      NOT NULL
                                           (Whisper,       
                                           Google STT,     
                                           etc.)           

  `audio_quality`         `VARCHAR(20)`    Audio quality   \-
                                           (High, Medium,  
                                           Low)            

  `duration_seconds`      `INTEGER`        Call duration   NOT NULL
  ------------------------------------------------------------------------

## Satisfaction Surveys

**Type:** Fact table\
**Rows:** 250,000\
**Source:** `Contact Center`\
**Partition:** `daily`

  ---------------------------------------------------------------------------
  Column                     Type             Description     Constraints
  -------------------------- ---------------- --------------- ---------------
  `survey_id`                `VARCHAR(30)`    Unique survey   PK, NOT NULL
                                              ID              

  `survey_date`              `TIMESTAMP`      Response date   NOT NULL
                                              and time        

  `process_date`             `DATE`           Process date    NOT NULL
                                              (partition key) 

  `interaction_id`           `VARCHAR(30)`    Evaluated       FK
                                              interaction ID  

  `customer_id`              `VARCHAR(20)`    Customer ID     FK, NOT NULL

  `agent_id`                 `VARCHAR(20)`    Evaluated agent FK
                                              ID              

  `survey_type`              `VARCHAR(20)`    Type (CSAT,     NOT NULL
                                              NPS, CES)       

  `send_channel`             `VARCHAR(30)`    Send channel    NOT NULL
                                              (Email, SMS,    
                                              IVR, App, Web)  

  `main_score`               `INTEGER`        Main score (1-5 NOT NULL
                                              for CSAT, 0-10  
                                              for NPS)        

  `nps_category`             `VARCHAR(20)`    NPS category    \-
                                              (Promoter,      
                                              Passive,        
                                              Detractor)      

  `question_1_text`          `TEXT`           Question 1 text \-

  `question_1_response`      `INTEGER`        Question 1      \-
                                              response (1-5)  

  `question_2_text`          `TEXT`           Question 2 text \-

  `question_2_response`      `INTEGER`        Question 2      \-
                                              response (1-5)  

  `question_3_text`          `TEXT`           Question 3 text \-

  `question_3_response`      `INTEGER`        Question 3      \-
                                              response (1-5)  

  `open_comments`            `TEXT`           Customer        \-
                                              comments (in    
                                              Spanish)        

  `comment_sentiment`        `VARCHAR(20)`    Comment         \-
                                              sentiment       

  `response_time_hours`      `DECIMAL(8,2)`   Hours between   \-
                                              interaction and 
                                              response        

  `campaign_response_rate`   `DECIMAL(5,2)`   Campaign        \-
                                              response rate   
                                              (%)             
  ---------------------------------------------------------------------------

## Digital Events

**Type:** Fact table\
**Rows:** 10,000,000\
**Source:** `Digital Banking`\
**Partition:** `daily`

  -------------------------------------------------------------------------
  Column               Type              Description       Constraints
  -------------------- ----------------- ----------------- ----------------
  `event_id`           `VARCHAR(30)`     Unique event ID   PK, NOT NULL

  `event_date`         `TIMESTAMP`       Event date and    NOT NULL
                                         time              

  `process_date`       `DATE`            Process date      NOT NULL
                                         (partition key)   

  `customer_id`        `VARCHAR(20)`     Customer ID       FK

  `session_id`         `VARCHAR(50)`     User session ID   NOT NULL

  `event_type`         `VARCHAR(50)`     Type (PageView,   NOT NULL
                                         Click,            
                                         FormSubmit,       
                                         Login, Logout,    
                                         Error, Purchase)  

  `event_category`     `VARCHAR(50)`     Category          NOT NULL
                                         (Navigation,      
                                         Transaction,      
                                         Authentication,   
                                         Product)          

  `channel`            `VARCHAR(30)`     Channel (Android  NOT NULL
                                         App, iOS App,     
                                         Desktop Web,      
                                         Mobile Web)       

  `platform`           `VARCHAR(30)`     Platform          \-
                                         (Android, iOS,    
                                         Windows, MacOS,   
                                         Linux)            

  `browser`            `VARCHAR(50)`     Browser used      \-

  `app_version`        `VARCHAR(20)`     App version       \-

  `page_url`           `VARCHAR(300)`    Page URL          \-

  `page_title`         `VARCHAR(200)`    Page title        \-

  `action`             `VARCHAR(100)`    Action performed  \-

  `element_id`         `VARCHAR(100)`    Interacted        \-
                                         element ID        

  `product_id`         `VARCHAR(20)`     Related product   FK
                                         ID                

  `event_value`        `DECIMAL(15,2)`   Event monetary    \-
                                         value (if         
                                         applicable)       

  `duration_seconds`   `INTEGER`         Event duration    \-

  `ip_address`         `VARCHAR(45)`     User IP address   \-

  `ip_country`         `VARCHAR(50)`     Country detected  \-
                                         by IP             

  `ip_city`            `VARCHAR(100)`    City detected by  \-
                                         IP                

  `is_mobile`          `BOOLEAN`         Event from mobile NOT NULL
                                         device            

  `referrer`           `VARCHAR(300)`    Referrer URL      \-

  `utm_source`         `VARCHAR(100)`    UTM source        \-

  `utm_medium`         `VARCHAR(100)`    UTM medium        \-

  `utm_campaign`       `VARCHAR(100)`    UTM campaign      \-
  -------------------------------------------------------------------------

## Complaints

**Type:** Fact table\
**Rows:** 80,000\
**Source:** `PQR`\
**Partition:** `daily`

  -------------------------------------------------------------------------------
  Column                      Type              Description       Constraints
  --------------------------- ----------------- ----------------- ---------------
  `complaint_id`              `VARCHAR(30)`     Unique            PK, NOT NULL
                                                complaint/claim   
                                                ID                

  `creation_date`             `TIMESTAMP`       Complaint         NOT NULL
                                                creation date     

  `process_date`              `DATE`            Process date      NOT NULL
                                                (partition key)   

  `customer_id`               `VARCHAR(20)`     Customer ID       FK, NOT NULL

  `case_type`                 `VARCHAR(30)`     Type (Complaint,  NOT NULL
                                                Claim, Request,   
                                                Suggestion)       

  `category`                  `VARCHAR(100)`    Case category     NOT NULL

  `subcategory`               `VARCHAR(100)`    Subcategory       \-

  `reception_channel`         `VARCHAR(30)`     Channel (Call     NOT NULL
                                                Center, Email,    
                                                Web, App, Branch, 
                                                Regulator)        

  `affected_product_id`       `VARCHAR(20)`     Affected product  FK
                                                ID                

  `related_branch_id`         `VARCHAR(20)`     Related branch ID FK

  `origin_interaction_id`     `VARCHAR(30)`     Originating       FK
                                                interaction ID    

  `description`               `TEXT`            Case description  NOT NULL
                                                (in Spanish)      

  `claimed_amount`            `DECIMAL(15,2)`   Claimed amount    \-
                                                (if applicable)   

  `currency`                  `VARCHAR(3)`      Claimed amount    \-
                                                currency          

  `priority`                  `VARCHAR(20)`     Priority (Low,    NOT NULL
                                                Medium, High,     
                                                Critical)         

  `status`                    `VARCHAR(30)`     Status (Open, In  NOT NULL
                                                Process,          
                                                Escalated,        
                                                Resolved, Closed, 
                                                Rejected)         

  `assigned_agent_id`         `VARCHAR(20)`     Assigned agent ID FK

  `assignment_date`           `TIMESTAMP`       Assignment date   \-

  `first_response_date`       `TIMESTAMP`       First response    \-
                                                date              

  `resolution_date`           `TIMESTAMP`       Resolution date   \-

  `closing_date`              `TIMESTAMP`       Closing date      \-

  `sla_breached`              `BOOLEAN`         SLA breached      NOT NULL

  `resolution_days`           `INTEGER`         Days to           \-
                                                resolution        

  `resolution`                `TEXT`            Resolution        \-
                                                description (in   
                                                Spanish)          

  `compensation_granted`      `DECIMAL(15,2)`   Compensation      \-
                                                amount granted    

  `resolution_satisfaction`   `INTEGER`         Resolution        \-
                                                satisfaction      
                                                score (1-5)       

  `is_repeat_complainer`      `BOOLEAN`         Customer with     NOT NULL
                                                previous          
                                                complaints in     
                                                last 90 days      
  -------------------------------------------------------------------------------

## Campaign Sends

**Type:** Fact table\
**Rows:** 2,000,000\
**Source:** `Internal`\
**Partition:** `daily`

  ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
  Column                                                                          Type                                                                                Description                               Constraints
  ------------------------------------------------------------------------------- ----------------------------------------------------------------------------------- ----------------------------------------- ----------------------------------
  `send_id`                                                                       `VARCHAR(30)`                                                                       Unique send ID                            PK, NOT NULL

  `send_date`                                                                     `TIMESTAMP`                                                                         Send date and time                        NOT NULL

  `process_date`                                                                  `DATE`                                                                              Process date (partition key)              NOT NULL

  `campaign_id`                                                                   `VARCHAR(20)`                                                                       Campaign ID                               FK, NOT NULL

  `customer_id`                                                                   `VARCHAR(20)`                                                                       Recipient customer ID                     FK, NOT NULL

  `send_channel`                                                                  `VARCHAR(30)`                                                                       Channel (Email, SMS, Push, WhatsApp,      NOT NULL
                                                                                                                                                                      Voice)                                    

  `template_used`                                                                 `VARCHAR(100)`                                                                      Template used                             \-

  `subject`                                                                       `VARCHAR(200)`                                                                      Message subject                           \-

  `send_status`                                                                   `VARCHAR(20)`                                                                       Status (Sent, Failed, Bounced, Blocked)   NOT NULL

  `was_delivered`                                                                 `BOOLEAN`                                                                           Was delivered successfully                NOT NULL

  `was_opened`                                                                    `BOOLEAN`                                                                           Was opened/read                           \-

  `open_date`                                                                     `TIMESTAMP`                                                                         Open date                                 \-

  `was_clicked`                                                                   `BOOLEAN`                                                                           Clicked on any link                       \-

  `click_date`                                                                    `TIMESTAMP`                                                                         First click date                          \-

  `click_count`                                                                   `INTEGER`                                                                           Total click count                         \-

  `had_conversion`                                                                `BOOLEAN`                                                                           Converted (completed desired action)      NOT NULL

  `conversion_date`                                                               `TIMESTAMP`                                                                         Conversion date                           \-

  `conversion_value`                                                              `DECIMAL(15,2)`                                                                     Conversion monetary value                 \-

  `open_device`                                                                   `VARCHAR(30)`                                                                       Device used to open                       \-

  `open_country`                                                                  `VARCHAR(50)`                                                                       Country where opened                      \-

  `failure_reason`                                                                `VARCHAR(200)`                                                                      Failure reason (if applicable)            \-

  `send_cost`                                                                     `DECIMAL(10,4)`                                                                     Individual send cost                      \-

  `Reference data for lookups and conversions.`                                   `Daily Exchange Rates [REFERENCE]`                                                  Rows: 3,000                               Source: Reference

  `Column`                                                                        `Type`                                                                              Description                               Constraints

  `date`                                                                          `DATE`                                                                              Exchange rate date                        PK, NOT NULL

  `source_currency`                                                               `VARCHAR(3)`                                                                        Source currency                           PK, NOT NULL

  `target_currency`                                                               `VARCHAR(3)`                                                                        Target currency                           PK, NOT NULL

  `exchange_rate`                                                                 `DECIMAL(12,6)`                                                                     Exchange rate                             NOT NULL

  `buy_rate`                                                                      `DECIMAL(12,6)`                                                                     Bank buy rate                             \-

  `sell_rate`                                                                     `DECIMAL(12,6)`                                                                     Bank sell rate                            \-

  `source`                                                                        `VARCHAR(50)`                                                                       Exchange rate source                      \-

  `The following foreign key relationships exist between tables:`                 `customers`                                                                         • products.customer_id →                  • transactions.customer_id →
                                                                                                                                                                      customers.customer_id                     customers.customer_id

  `• call_center_interactions.customer_id → customers.customer_id`                `• call_transcripts.customer_id → customers.customer_id`                            • satisfaction_surveys.customer_id →      • digital_events.customer_id →
                                                                                                                                                                      customers.customer_id                     customers.customer_id

  `• complaints.customer_id → customers.customer_id`                              `• campaign_sends.customer_id → customers.customer_id`                              branches                                  • customers.registration_branch_id
                                                                                                                                                                                                                → branches.branch_id

  `• products.opening_branch_id → branches.branch_id`                             `• service_agents.assigned_branch_id → branches.branch_id`                          • transactions.branch_id →                • complaints.related_branch_id →
                                                                                                                                                                      branches.branch_id                        branches.branch_id

  `service_agents`                                                                `• call_center_interactions.agent_id → service_agents.agent_id`                     • call_transcripts.agent_id →             • satisfaction_surveys.agent_id →
                                                                                                                                                                      service_agents.agent_id                   service_agents.agent_id

  `• complaints.assigned_agent_id → service_agents.agent_id`                      `products`                                                                          • transactions.product_id →               • digital_events.product_id →
                                                                                                                                                                      products.product_id                       products.product_id

  `• complaints.affected_product_id → products.product_id`                        `marketing_campaigns`                                                               • campaign_sends.campaign_id →            call_center_interactions
                                                                                                                                                                      marketing_campaigns.campaign_id           

  `• call_transcripts.interaction_id → call_center_interactions.interaction_id`   `• satisfaction_surveys.interaction_id → call_center_interactions.interaction_id`   • complaints.origin_interaction_id →      \-
                                                                                                                                                                      call_center_interactions.interaction_id   
  ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------

## Reference Tables

Reference data for lookups and conversions.

### Daily Exchange Rates

**Type:** Reference table\
**Rows:** 3,000\
**Source:** `Reference`\
**Partition:** `daily`

Daily exchange rates for currency conversion.

  Column              Type              Description            Constraints
  ------------------- ----------------- ---------------------- --------------
  `date`              `DATE`            Exchange rate date     PK, NOT NULL
  `source_currency`   `VARCHAR(3)`      Source currency        PK, NOT NULL
  `target_currency`   `VARCHAR(3)`      Target currency        PK, NOT NULL
  `exchange_rate`     `DECIMAL(12,6)`   Exchange rate          NOT NULL
  `buy_rate`          `DECIMAL(12,6)`   Bank buy rate          \-
  `sell_rate`         `DECIMAL(12,6)`   Bank sell rate         \-
  `source`            `VARCHAR(50)`     Exchange rate source   \-

## Foreign Key Relationships

The following foreign key relationships exist between tables.

### `customers`

-   `products.customer_id` → `customers.customer_id`
-   `transactions.customer_id` → `customers.customer_id`
-   `call_center_interactions.customer_id` → `customers.customer_id`
-   `call_transcripts.customer_id` → `customers.customer_id`
-   `satisfaction_surveys.customer_id` → `customers.customer_id`
-   `digital_events.customer_id` → `customers.customer_id`
-   `complaints.customer_id` → `customers.customer_id`
-   `campaign_sends.customer_id` → `customers.customer_id`

### `branches`

-   `customers.registration_branch_id` → `branches.branch_id`
-   `products.opening_branch_id` → `branches.branch_id`
-   `service_agents.assigned_branch_id` → `branches.branch_id`
-   `transactions.branch_id` → `branches.branch_id`
-   `complaints.related_branch_id` → `branches.branch_id`

### `service_agents`

-   `call_center_interactions.agent_id` → `service_agents.agent_id`
-   `call_transcripts.agent_id` → `service_agents.agent_id`
-   `satisfaction_surveys.agent_id` → `service_agents.agent_id`
-   `complaints.assigned_agent_id` → `service_agents.agent_id`

### `products`

-   `transactions.product_id` → `products.product_id`
-   `digital_events.product_id` → `products.product_id`
-   `complaints.affected_product_id` → `products.product_id`

### `marketing_campaigns`

-   `campaign_sends.campaign_id` → `marketing_campaigns.campaign_id`

### `call_center_interactions`

-   `call_transcripts.interaction_id` →
    `call_center_interactions.interaction_id`
-   `satisfaction_surveys.interaction_id` →
    `call_center_interactions.interaction_id`
-   `complaints.origin_interaction_id` →
    `call_center_interactions.interaction_id`

## Potential Use Cases

### Customer Analytics

-   Customer segmentation and clustering.
-   Churn prediction models.
-   Customer lifetime value (CLV) analysis.
-   Cross-sell and up-sell opportunity identification.

### Contact Center Optimization

-   First Call Resolution (FCR) improvement.
-   Agent performance analysis.
-   Sentiment trend analysis.
-   Accent-based routing optimization.

### Fraud Detection

-   Transaction fraud detection models.
-   Anomaly detection in spending patterns.
-   Geographic risk modeling.

### Marketing Analytics

-   Campaign effectiveness measurement.
-   Channel attribution modeling.
-   Personalization models.
-   A/B testing analysis.

### NLP / Text Analytics

-   Topic modeling on call transcripts.
-   Intent classification.
-   Entity extraction.
-   Multilingual accent detection.

## Important Notes

-   **Spanish Language Data:** All text data is in Spanish with regional
    variations.
-   **Accent Detection:** Dataset includes Mexican, Colombian, and
    Argentine accent fields.
-   **Multi-Currency:** Transactions include local currency and USD
    conversion.
-   **Date Partitioning:** Large fact tables are partitioned by
    year/month/day.
-   **Synthetic Data:** Completely synthetic --- no real customer
    information.
-   **Referential Integrity:** Foreign-key relationships are maintained,
    with a small percentage of orphaned records for testing.

## Schema Notes

-   Fact tables are partitioned by `process_date`.
-   Primary keys are marked `PK`.
-   Required fields are marked `NOT NULL`.
-   Foreign keys are marked `FK`.
-   Some fields intentionally have no constraint (`-`).
-   Text fields describing customer interactions are explicitly
    identified as Spanish in the source.
-   Preserve exact source column names when querying or transforming the
    dataset.
