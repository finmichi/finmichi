# Synthetic test oracle authored independently in Python Decimal, not production code or a CI dependency.
from decimal import Decimal as D,localcontext,ROUND_HALF_UP
from pathlib import Path
import json,hashlib
T=Path(__file__).resolve().parent
def fixed(v,places=2):return str(v.quantize(D(1).scaleb(-places),rounding=ROUND_HALF_UP))
def replay(rows):
 q=0;c=D(0);out=[]
 with localcontext() as ctx:
  ctx.prec=100
  for t in rows:
   before_q=q;before_c=c;typ=t['trade_type'];qty=int(t.get('quantity','0'));fee=D(t.get('fee','0'));tax=D(t.get('tax','0'));gross=D(fixed(D(qty)*D(t.get('price','0'))));removed=D(0);pnl=D(0)
   if typ=='buy':q+=qty;c+=gross+fee+tax
   elif typ=='sell':
    if q<qty:raise ValueError('insufficient_shares')
    removed=c if q==qty else D(fixed(c*D(qty)/D(q)));q-=qty;c-=removed;pnl=gross-removed-fee-tax
   elif typ=='stock_dividend':q+=qty
   elif typ=='adjust':
    q=int(t['quantity_after']);mode=t['cost_mode']
    if mode=='keep':
     if q==0:raise ValueError('adjust_cost_required')
    elif mode=='set_cost':c=D(t['cost_after']);pnl=c-before_c
    elif mode=='cash_return':cash=D(t['cash_amount']);pnl=max(cash-c,D(0));c=max(c-cash,D(0))
    if q==0 and c!=0:raise ValueError('adjust_cost_required')
   out.append({'quantity_before':str(before_q),'cost_before':fixed(before_c),'gross':fixed(gross),'cost_removed':fixed(removed),'quantity_after':str(q),'cost_after':fixed(c),'realized_gain':fixed(pnl),'average_cost':fixed(c/D(q),4) if q else '0.0000'})
 return out
B=lambda q,p,**k:dict(trade_type='buy',quantity=str(q),price=p,**k)
S=lambda q,p,**k:dict(trade_type='sell',quantity=str(q),price=p,**k)
A=lambda q,m,**k:dict(trade_type='adjust',quantity_after=str(q),cost_mode=m,**k)
cases={
 'partial_and_final_sale':[B(100,'10',fee='2'),B(50,'12.345678',fee='3',tax='1'),S(40,'15.678901',fee='1.23',tax='0.45'),S(110,'9.999999',fee='2.50',tax='0.75')],
 'half_cent_and_final_residue':[B(1,'1.005'),B(1,'2.675'),S(1,'5',fee='0.05',tax='0.01'),S(1,'3')],
 'stock_dividend':[B(3,'0.333333',fee='0.01'),dict(trade_type='stock_dividend',quantity='1'),S(1,'0.5'),S(3,'0.5')],
 'split_keep':[B(100,'10'),A(200,'keep'),S(50,'6')],
 'set_cost_both_directions':[B(10,'10'),A(10,'set_cost',cost_after='80'),A(10,'set_cost',cost_after='110')],
 'write_off':[B(10,'10'),A(0,'set_cost',cost_after='0')],
 'cash_return_below_and_above_cost':[B(10,'10'),A(8,'cash_return',cash_amount='30'),A(0,'cash_return',cash_amount='100')],
 'before_backdate':[B(100,'10'),S(100,'20')],
 'after_backdate':[B(100,'30'),B(100,'10'),S(100,'20')],
 'same_day_different_sequence':[B(100,'10'),S(100,'20'),B(100,'30')],
}
result={'synthetic_only':True,'oracle':'Python Decimal precision100 ROUND_HALF_UP; no production math imported','cases':[{ 'name':name,'input':rows,'expected':replay(rows)} for name,rows in cases.items()]}
for name,rows,code in [('insufficient',[B(1,'10'),S(2,'20')],'insufficient_shares'),('keep_zero',[B(10,'10'),A(0,'keep')],'adjust_cost_required'),('zero_with_cost',[B(10,'10'),A(0,'set_cost',cost_after='1')],'adjust_cost_required')]:
 try:replay(rows);raise AssertionError(name)
 except ValueError as e:assert str(e)==code
 result.setdefault('error_cases',[]).append({'name':name,'input':rows,'error':code})
p=T/'oracle.json';p.write_text(json.dumps(result,ensure_ascii=False,indent=2)+'\n');print('Prepared synthetic independent oracle:',len(cases),'scenarios;',len(result['error_cases']),'error cases;',hashlib.sha256(p.read_bytes()).hexdigest())
