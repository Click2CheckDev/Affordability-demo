// SIMULATED for the demo -- not model output. Source: static_demo/simulated_ai.json
window.SIMULATED_AI = {
  "_note": "SIMULATED for the static demo -- not output from a model. Written to show what the AI mapping step proposes for the fields the rules leave blank: the same shape the live service's affordability/ai.py returns (a path, or a sum of money lines, plus a one-line reason). The page labels these as simulated.",
  "acme": {
    "Budget!B14": {"path": "expenditure.rent", "reason": "\"Rent, including service charge\" is C2C's Rental payments line."},
    "Budget!B16": {"sum": ["expenditure.gas", "expenditure.electricity"], "reason": "One cell for both fuels; C2C keeps gas and electricity apart, so add them."},
    "Budget!B18": {"path": "expenditure.telephone", "reason": "Landline and broadband is C2C's Telephone line."},
    "Budget!B20": {"path": "expenditure.television", "reason": "TV licence and a Sky package are both on C2C's Television line."},
    "Budget!B21": {"path": "expenditure.groceries", "reason": "\"Food shopping, supermarket\" is the Groceries line."},
    "Budget!B22": {"path": "expenditure.other_food", "reason": "Eating out, drinks and takeaways is C2C's Other food expenses."},
    "Budget!B23": {"path": "expenditure.car", "reason": "C2C's Car line is defined as car insurance and road tax."},
    "Budget!B24": {"path": "expenditure.other_travel", "reason": "Petrol and diesel sit on Other travel expense on the C2C form."},
    "Budget!B26": {"path": "expenditure.memberships", "reason": "Gym and club fees are C2C's Memberships."},
    "Budget!B30": {"path": "expenditure.gambling", "reason": "Betting and lottery is the Gambling and lotteries line."},
    "Budget!B31": {"path": "expenditure.pensions", "reason": "Personal pension contributions are C2C's Pensions line."},
    "Budget!B32": {"path": "expenditure.credit_cards", "reason": "Monthly card repayments, totalled from the commitments."}
  },
  "lender": {
    "NetInc_Mthly": {"path": "summary.net_monthly_income", "reason": "A household total, so the summary figure, not one applicant's."},
    "Hsg_RentMtg": {"sum": ["expenditure.rent", "expenditure.mortgage_main"], "reason": "Rent or the main mortgage. Buy-to-let mortgages are left out, as they aren't housing costs."},
    "Util_GasElec": {"sum": ["expenditure.gas", "expenditure.electricity"], "reason": "Both fuels in one field."},
    "Util_Comms": {"sum": ["expenditure.telephone", "expenditure.mobile", "expenditure.television"], "reason": "Phone, broadband and TV covers three C2C lines."},
    "Food_Hhold": {"path": "expenditure.groceries", "reason": "C2C's Groceries line is the food and household shop."},
    "Trans_Total": {"sum": ["expenditure.travel_to_work", "expenditure.other_travel", "expenditure.car", "expenditure.car_repairs"], "reason": "All of C2C's travel and running-a-car lines."},
    "Out_Total": {"path": "summary.monthly_expenditure", "reason": "Total outgoings from the C2C summary."}
  }
};
