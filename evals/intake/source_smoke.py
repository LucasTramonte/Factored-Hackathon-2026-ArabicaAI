"""Optional read-only smoke probe against the exploration SQLite cache.

Queries are parameter-bound and projected; no raw customer/transaction IDs are
written to the report. SQLite owns full-data scans; Python holds <= 101 matches.
"""
import argparse
from contextlib import closing
from decimal import Decimal
import json
from pathlib import Path
import sqlite3
from .baseline import decide


class SourceStore:
    """Read exact native-currency matches from the verified exploration cache."""
    def __init__(self, connection):self.connection=connection
    def query(self, customer_id, filters):
        """Return bounded matches; excessive ambiguity fails closed rather than truncates."""
        try:
            rows=self.connection.execute('''SELECT transaction_id, customer_id, transaction_date,
                amount, currency, merchant_name FROM eligible_transactions
                WHERE customer_id=? AND substr(transaction_date,1,10)=? AND amount=? AND currency=? LIMIT 101''',
                (customer_id,filters['date'],int(filters['amount']*100),filters['currency'])).fetchall()
        except sqlite3.Error as exc:
            raise OSError("Source lookup unavailable") from exc
        if len(rows)>100:raise ValueError('Too many candidates')
        return [dict(transaction_id=r[0],customer_id=r[1],transaction_date=r[2][:10],
                     amount=str(Decimal(r[3])/100),currency=r[4],merchant_name=r[5]) for r in rows]


def main():
    """Check one valid confirmation and one forged confirmation without exposing records."""
    parser=argparse.ArgumentParser();parser.add_argument('--database',type=Path,default=Path('data_foundation/runs/meeting-exploration/meeting.sqlite'))
    parser.add_argument('--output',type=Path,default=Path('data_foundation/runs/intake-evaluation/source-smoke.json'))
    args=parser.parse_args()
    with closing(sqlite3.connect(args.database.resolve().as_uri()+'?mode=ro',uri=True)) as con:
        row=con.execute("SELECT transaction_id,customer_id,substr(transaction_date,1,10),amount,currency FROM eligible_transactions WHERE amount>0 AND currency='USD' AND transaction_date IS NOT NULL LIMIT 1").fetchone()
        if row is None:raise ValueError('No suitable source row')
        foreign=con.execute('SELECT transaction_id FROM eligible_transactions WHERE customer_id!=? LIMIT 1',(row[1],)).fetchone()
        if foreign is None:raise ValueError('No foreign-customer contrast')
        message=f'No reconozco un cargo de {Decimal(row[3])/100} {row[4]} del {row[2]}'
        args_call=dict(message=message,customer_id=row[1],authenticated=True,language='es',store=SourceStore(con),case_id='source-smoke')
        good=decide(**args_call,confirmed_id=row[0]);bad=decide(**args_call,confirmed_id=foreign[0])
        assert good['action']=='complete_handoff' and good['candidates'][0]['transaction_id']==row[0]
        assert bad['action']=='clarify' and not bad['candidates']
    result=dict(scope='Two decisions on one source transaction; integration smoke only, not performance evidence',read_only=True,confirmed_owned_transaction=True,rejected_foreign_confirmation=True)
    args.output.parent.mkdir(parents=True,exist_ok=True);args.output.write_text(json.dumps(result,indent=2)+'\n');print(json.dumps(result))

if __name__=='__main__':main()
