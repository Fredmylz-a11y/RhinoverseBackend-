export default async function handler(req,res){
  res.setHeader('Access-Control-Allow-Origin','*');
  if(req.method==='OPTIONS') return res.status(200).end();
  return res.json({balance:3000,bonus:3000,dailyIncome:0,user:{balance:3000,bonus:3000}});
}
